use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, Mutex};

use super::protocol::{unwrap_from_wire, wrap_for_wire, Frame};

#[derive(Debug, Clone)]
pub enum UdsEvent {
    Connecting,
    Connected,
    Disconnected(String),
    Frame(Frame),
    Error(String),
}

pub struct UdsClient {
    pub tx_to_server: mpsc::Sender<Frame>,
    pub event_rx: Arc<Mutex<mpsc::Receiver<UdsEvent>>>,
}

impl Clone for UdsClient {
    fn clone(&self) -> Self {
        Self {
            tx_to_server: self.tx_to_server.clone(),
            event_rx: self.event_rx.clone(),
        }
    }
}

pub fn spawn(socket_path: PathBuf, access_token: String) -> UdsClient {
    let (tx_to_server, mut rx_to_server) = mpsc::channel::<Frame>(32);
    let (event_tx, event_rx) = mpsc::channel::<UdsEvent>(64);

    tokio::spawn(async move {
        let mut delay = Duration::from_millis(500);
        loop {
            let _ = event_tx.send(UdsEvent::Connecting).await;
            match UnixStream::connect(&socket_path).await {
                Ok(stream) => {
                    delay = Duration::from_millis(500);
                    let (read_half, mut write_half) = stream.into_split();
                    let _ = event_tx.send(UdsEvent::Connected).await;

                    // Handshake: send hello.
                    let hello = Frame::Hello {
                        token: access_token.clone(),
                        device: "host-local".into(),
                    };
                    if let Ok(line) = wrap_for_wire(&hello, &access_token) {
                        let _ = write_half.write_all(line.as_bytes()).await;
                        let _ = write_half.write_all(b"\n").await;
                    }

                    let reader_token = access_token.clone();
                    let reader_event_tx = event_tx.clone();
                    let reader_task = tokio::spawn(async move {
                        let mut buf = BufReader::new(read_half);
                        let mut line = String::new();
                        loop {
                            line.clear();
                            match buf.read_line(&mut line).await {
                                Ok(0) => break,
                                Ok(_) => {
                                    let trimmed = line.trim_end();
                                    if trimmed.is_empty() {
                                        continue;
                                    }
                                    match unwrap_from_wire(trimmed, &reader_token) {
                                        Ok(f) => {
                                            let _ = reader_event_tx
                                                .send(UdsEvent::Frame(f))
                                                .await;
                                        }
                                        Err(e) => {
                                            let _ = reader_event_tx
                                                .send(UdsEvent::Error(e))
                                                .await;
                                        }
                                    }
                                }
                                Err(e) => {
                                    let _ = reader_event_tx
                                        .send(UdsEvent::Error(e.to_string()))
                                        .await;
                                    break;
                                }
                            }
                        }
                    });

                    while let Some(frame) = rx_to_server.recv().await {
                        match wrap_for_wire(&frame, &access_token) {
                            Ok(line) => {
                                if write_half.write_all(line.as_bytes()).await.is_err() {
                                    break;
                                }
                                if write_half.write_all(b"\n").await.is_err() {
                                    break;
                                }
                            }
                            Err(e) => {
                                let _ = event_tx.send(UdsEvent::Error(e)).await;
                            }
                        }
                    }

                    let _ = reader_task.await;
                    let _ = event_tx.send(UdsEvent::Disconnected("eof".into())).await;
                }
                Err(e) => {
                    let _ = event_tx
                        .send(UdsEvent::Error(format!("connect failed: {}", e)))
                        .await;
                }
            }

            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(60));
        }
    });

    UdsClient {
        tx_to_server,
        event_rx: Arc::new(Mutex::new(event_rx)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use tokio::net::UnixListener;
    use tokio::time::timeout;

    #[tokio::test]
    async fn connects_and_sends_hello() {
        let dir = tempdir().unwrap();
        let sock = dir.path().join("test.sock");
        let listener = UnixListener::bind(&sock).unwrap();

        let sock_path = sock.clone();
        let accept_task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut buf = BufReader::new(stream);
            let mut line = String::new();
            buf.read_line(&mut line).await.unwrap();
            line
        });

        let token = "t".repeat(64);
        let _client = spawn(sock_path, token.clone());
        let line = timeout(Duration::from_secs(2), accept_task)
            .await
            .unwrap()
            .unwrap();
        assert!(line.contains("hello"));
        assert!(line.contains("\"mac\""));
    }
}
