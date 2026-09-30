//! Async NDJSON adapter: Host responses must keep flowing while a UI request
//! awaits the index. The SDK's synchronous plugin callback cannot do that.
use crate::engine::Engine;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot},
};

pub type Reply = Result<Value, String>;
pub type RequestFuture<'a> = Pin<Box<dyn Future<Output = Reply> + Send + 'a>>;
pub trait Host: Send + Sync {
    fn request<'a>(&'a self, method: &'a str, params: Value) -> RequestFuture<'a>;
    fn post(&self, payload: Value);
}
enum Out {
    Line(Value),
    Close,
}
struct WireHost {
    output: mpsc::UnboundedSender<Out>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    next: AtomicU64,
}
impl Host for WireHost {
    fn request<'a>(&'a self, method: &'a str, params: Value) -> RequestFuture<'a> {
        Box::pin(async move {
            let id = self.next.fetch_add(1, Ordering::Relaxed);
            let (tx, rx) = oneshot::channel();
            self.pending
                .lock()
                .map_err(|_| "RPC state unavailable")?
                .insert(id, tx);
            self.output
                .send(Out::Line(
                    json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
                ))
                .map_err(|_| "Host connection closed")?;
            let result = tokio::time::timeout(std::time::Duration::from_secs(100), rx).await;
            self.pending
                .lock()
                .map_err(|_| "RPC state unavailable")?
                .remove(&id);
            result
                .map_err(|_| format!("{method} 超时"))?
                .map_err(|_| "Host connection closed".to_string())?
        })
    }
    fn post(&self, payload: Value) {
        let _ = self.output.send(Out::Line(json!({"jsonrpc":"2.0","method":"host.ui.post","params":{"window_id":"main","payload":payload}})));
    }
}
fn response(id: Value, result: Reply) -> Value {
    match result {
        Ok(value) => json!({"jsonrpc":"2.0","id":id,"result":value}),
        Err(error) => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":error}}),
    }
}
pub async fn serve<R, W>(reader: R, mut writer: W)
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (tx, mut rx) = mpsc::unbounded_channel();
    let writer_task = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            match message {
                Out::Line(value) => {
                    let mut bytes = serde_json::to_vec(&value).unwrap_or_default();
                    bytes.push(b'\n');
                    if writer.write_all(&bytes).await.is_err() || writer.flush().await.is_err() {
                        break;
                    }
                }
                Out::Close => break,
            }
        }
    });
    let host = Arc::new(WireHost {
        output: tx.clone(),
        pending: Mutex::new(HashMap::new()),
        next: AtomicU64::new(1),
    });
    let engine = Arc::new(Engine::new());
    let mut handlers = tokio::task::JoinSet::new();
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("method").is_none() {
            if let Some(id) = value["id"].as_u64() {
                if let Some(sender) = host.pending.lock().unwrap().remove(&id) {
                    let result = if let Some(error) = value.get("error") {
                        Err(error["message"]
                            .as_str()
                            .unwrap_or("Host request failed")
                            .to_string())
                    } else {
                        Ok(value["result"].clone())
                    };
                    let _ = sender.send(result);
                }
            }
            continue;
        }
        let id = value.get("id").cloned();
        let method = value["method"].as_str().unwrap_or("").to_string();
        let params = value.get("params").cloned().unwrap_or(json!({}));
        if method == "$deactivate" {
            engine.shutdown();
            if let Some(id) = id {
                let _ = tx.send(Out::Line(response(id, Ok(json!({"ok":true})))));
            }
            break;
        }
        if method == "$initialize" {
            let result = engine.initialize(&params).map(|_| json!({"ok":true}));
            if let Some(id) = id {
                let _ = tx.send(Out::Line(response(id, result)));
            }
            continue;
        }
        while handlers.try_join_next().is_some() {}
        let (engine, host, tx) = (engine.clone(), host.clone(), tx.clone());
        handlers.spawn(async move {
            let result = match method.as_str() {
                "$activate" => Ok(json!({"ok":true})),
                "ui.request" => {
                    engine
                        .handle(
                            host,
                            params["method"].as_str().unwrap_or(""),
                            params["params"].clone(),
                        )
                        .await
                }
                "command.execute" => Ok(json!({"ok":true})),
                _ => Err("Unknown STRATA method".into()),
            };
            if let Some(id) = id {
                let _ = tx.send(Out::Line(response(id, result)));
            }
        });
    }
    engine.shutdown();
    handlers.abort_all();
    host.pending.lock().unwrap().clear();
    let _ = tx.send(Out::Close);
    let _ = writer_task.await;
}
