mod ipc;
mod publish;
mod slug;
mod unpublish;

use std::io::{self, Read, Write};
use ipc::{Request, Response};

const PLUGIN_NAME: &str = "Share";

fn main() {
    let mut input = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut input) {
        emit(Response::fail(vec![ipc::toast_error(PLUGIN_NAME, "无法读取 stdin", Some(&e.to_string()))]));
        return;
    }
    let req: Request = match serde_json::from_str(input.trim()) {
        Ok(r) => r,
        Err(e) => {
            emit(Response::fail(vec![ipc::toast_error(PLUGIN_NAME, "请求 JSON 解析失败", Some(&e.to_string()))]));
            return;
        }
    };

    let resp = match req.command.as_str() {
        "publish" => publish::run(req),
        "unpublish" => unpublish::run(req),
        "copy-link" => Response::fail(vec![ipc::toast_error(PLUGIN_NAME, "copy-link 未实现", None)]),
        other => Response::fail(vec![ipc::toast_error(PLUGIN_NAME, "未知命令", Some(other))]),
    };
    emit(resp);
}

fn emit(resp: Response) {
    let s = serde_json::to_string(&resp).expect("serialize response");
    let stdout = io::stdout();
    let mut h = stdout.lock();
    h.write_all(s.as_bytes()).expect("write stdout");
    h.write_all(b"\n").expect("write newline");
}
