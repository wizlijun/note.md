use schemars::schema_for;
use std::{fs, path::Path};

fn main() {
    // 输出目录：仓库根 protocol/schema/（crate 在根目录，向上一级）
    let out = Path::new(env!("CARGO_MANIFEST_DIR")).join("../protocol/schema");
    fs::create_dir_all(&out).unwrap();
    let manifest = schema_for!(plugin_protocol::ManifestV2);
    fs::write(out.join("manifest-v2.schema.json"),
        serde_json::to_string_pretty(&manifest).unwrap() + "\n").unwrap();
    // rpc.schema.json：信封 + 全部负载类型合并为 definitions
    let mut rpc = serde_json::json!({ "$defs": {} });
    macro_rules! add { ($t:ty) => {{
        let s = schema_for!($t);
        rpc["$defs"][stringify!($t)] = serde_json::to_value(s).unwrap();
    }}}
    add!(plugin_protocol::RpcRequest); add!(plugin_protocol::RpcResponse);
    add!(plugin_protocol::RpcError); add!(plugin_protocol::InitializeParams);
    add!(plugin_protocol::ActivateParams); add!(plugin_protocol::ExecuteCommandParams);
    add!(plugin_protocol::ToastParams); add!(plugin_protocol::LogParams);
    add!(plugin_protocol::UiRequestParams); add!(plugin_protocol::UiPostParams);
    fs::write(out.join("rpc.schema.json"),
        serde_json::to_string_pretty(&rpc).unwrap() + "\n").unwrap();
    println!("schemas written to {}", out.display());
}
