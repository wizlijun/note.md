use std::sync::Arc;
use std::time::Duration;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;

use super::protocol::Frame;

/// Envelope as understood by mdrelay (Plan 3 wire spec).
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct Envelope {
    pub to: String,   // "host" | "remote:<id>" | "broadcast"
    pub from: String, // "host" | "remote:<id>"
    #[serde(flatten)]
    pub frame: Frame,
}

#[derive(Debug, Clone)]
pub enum RelayEvent {
    Connecting,
    Connected,
    Disconnected(String),
    Envelope(Envelope),
    Error(String),
}

pub struct RelayClient {
    pub tx_send: mpsc::Sender<Envelope>,
    pub event_rx: Arc<Mutex<mpsc::Receiver<RelayEvent>>>,
}

impl Clone for RelayClient {
    fn clone(&self) -> Self {
        Self {
            tx_send: self.tx_send.clone(),
            event_rx: self.event_rx.clone(),
        }
    }
}

pub fn spawn(relay_url: String, role: &'static str, device_token: String) -> RelayClient {
    let (tx_send, mut rx_send) = mpsc::channel::<Envelope>(32);
    let (event_tx, event_rx) = mpsc::channel::<RelayEvent>(64);

    tokio::spawn(async move {
        let mut delay = Duration::from_millis(500);
        loop {
            let _ = event_tx.send(RelayEvent::Connecting).await;
            let ws_url = format!(
                "{}/ws/{}?token={}",
                relay_url
                    .trim_end_matches('/')
                    .replace("http://", "ws://")
                    .replace("https://", "wss://"),
                role,
                urlencoding::encode(&device_token)
            );
            let url = match Url::parse(&ws_url) {
                Ok(u) => u,
                Err(e) => {
                    let _ = event_tx.send(RelayEvent::Error(e.to_string())).await;
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(Duration::from_secs(60));
                    continue;
                }
            };

            match connect_async(url.as_str()).await {
                Ok((socket, _resp)) => {
                    delay = Duration::from_millis(500);
                    let _ = event_tx.send(RelayEvent::Connected).await;

                    // Split to avoid dual &mut borrow inside select!
                    let (mut sink, mut stream) = socket.split();

                    loop {
                        tokio::select! {
                            outgoing = rx_send.recv() => {
                                match outgoing {
                                    Some(env) => {
                                        let s = match serde_json::to_string(&env) {
                                            Ok(s) => s,
                                            Err(e) => {
                                                let _ = event_tx
                                                    .send(RelayEvent::Error(e.to_string()))
                                                    .await;
                                                continue;
                                            }
                                        };
                                        if sink.send(Message::Text(s)).await.is_err() {
                                            break;
                                        }
                                    }
                                    None => return, // channel closed — shut down task
                                }
                            }
                            incoming = stream.next() => {
                                match incoming {
                                    Some(Ok(Message::Text(t))) => {
                                        match serde_json::from_str::<Envelope>(&t) {
                                            Ok(env) => {
                                                let _ = event_tx
                                                    .send(RelayEvent::Envelope(env))
                                                    .await;
                                            }
                                            Err(e) => {
                                                let _ = event_tx
                                                    .send(RelayEvent::Error(
                                                        format!("envelope parse: {}", e),
                                                    ))
                                                    .await;
                                            }
                                        }
                                    }
                                    Some(Ok(Message::Close(_))) | None => break,
                                    Some(Ok(_)) => { /* ignore ping/pong/binary */ }
                                    Some(Err(e)) => {
                                        let _ = event_tx
                                            .send(RelayEvent::Error(e.to_string()))
                                            .await;
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    let _ = event_tx
                        .send(RelayEvent::Disconnected("eof".into()))
                        .await;
                }
                Err(e) => {
                    let _ = event_tx
                        .send(RelayEvent::Error(format!("connect: {}", e)))
                        .await;
                }
            }

            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(60));
        }
    });

    RelayClient {
        tx_send,
        event_rx: Arc::new(Mutex::new(event_rx)),
    }
}
