//! Real executable tests: no UI, accounts, network, or formal Vault.
use serde_json::{json,Value};
use std::{path::Path, time::Duration};
use tokio::{io::{AsyncBufReadExt,AsyncWriteExt,BufReader,Lines},process::{Child,ChildStdin,ChildStdout,Command}};
use sumi_protocol::durability::{Create,LocalEdit,Request,CommitReceipt,Loaded};
struct Process {child:Child,input:ChildStdin,output:Lines<BufReader<ChildStdout>>,next:u64}
impl Process {
    async fn start()->Self {
        // Release acceptance can exercise the exact signed artifact without
        // replacing the development executable or touching a real Vault.
        let binary=std::env::var_os("SUMI_TEST_BINARY").unwrap_or_else(||env!("CARGO_BIN_EXE_notemd-sumi").into());
        Self::start_path(Path::new(&binary)).await
    }
    async fn start_path(binary:&Path)->Self {
        let mut child=Command::new(binary)
            .env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("TMPDIR", std::env::temp_dir()).env("LANG", "en_US.UTF-8")
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped()).kill_on_drop(true).spawn().unwrap();
        let input=child.stdin.take().unwrap();let output=BufReader::new(child.stdout.take().unwrap()).lines();
        let mut proc=Self {child,input,output,next:1000};
        proc.raw("$initialize",json!({"protocol_version":2,"host_version":"6.1108.6","locale":"zh","theme":"light","plugin_root":"/isolated/plugin","data_dir":"/isolated/data"})).await.unwrap();
        proc.raw("$activate",json!({"event":"onCommand:open"})).await.unwrap();proc
    }
    async fn send(&mut self,value:Value) {
        self.input.write_all(format!("{value}\n").as_bytes()).await.unwrap();self.input.flush().await.unwrap();
    }
    async fn read(&mut self)->Value {
        let line=tokio::time::timeout(Duration::from_secs(10),self.output.next_line()).await.expect("backend did not answer").unwrap().expect("backend stdout closed");
        serde_json::from_str(&line).unwrap()
    }
    async fn acknowledge(&mut self,message:&Value) {
        if message["method"].as_str()==Some("host.sumi.service") {
            assert_eq!(message["params"]["method"],"durable","network must not start implicitly");
            if let Some(id)=message.get("id") {self.send(json!({"jsonrpc":"2.0","id":id,"result":null})).await;}
        } else {assert!(message.get("method").is_none(),"unexpected host callback");}
    }
    async fn raw(&mut self,method:&str,params:Value)->Result<Value,Value> {
        let id=self.next;self.next+=1;self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})).await;
        loop {let message=self.read().await;
            if message.get("method").is_some(){self.acknowledge(&message).await;continue;}
            if message["id"]==id {return if let Some(error)=message.get("error"){Err(error.clone())}else{Ok(message["result"].clone())};}
        }
    }
    async fn service(&mut self,method:&str,params:Value)->Result<Value,Value>{self.raw("service.request",json!({"method":method,"params":params})).await}
    async fn hello(&mut self)->String {self.service("hello",json!({"version":1})).await.unwrap()["instance"].as_str().unwrap().into()}
    async fn open(&mut self,instance:&str,session:&str,dir:&Path)->Value {
        self.service("open",json!({"version":1,"instance":instance,"session":session,"vault":dir.join("vault"),"database":dir.join("private/documents.sqlite3"),"fontCache":dir.join("fonts")})).await.unwrap()
    }
    async fn durable(&mut self,instance:&str,session:&str,request:Request)->Result<Value,Value>{self.service("durability",json!({"instance":instance,"session":session,"payload":request})).await}
}
#[tokio::test]
async fn real_stdio_advertises_and_serves_atomic_observation() {
    let temp=tempfile::tempdir().unwrap();std::fs::create_dir(temp.path().join("vault")).unwrap();
    let mut process=Process::start().await;
    let hello:sumi_protocol::service::Hello=serde_json::from_value(process.service("hello",json!({"version":1})).await.unwrap()).unwrap();
    let page=uuid::Uuid::new_v4().to_string();let session=uuid::Uuid::new_v4().to_string();
    process.open(&hello.instance,&session,temp.path()).await;
    let doc=write_core::Document::new(&page,1,19).unwrap();
    process.durable(&hello.instance,&session,Request::Create(Create {page_id:page.clone(),epoch:1,full_state:doc.encode_full(),revision:0,after_id:None,first_write_date:None,frontmatter:None,preserved_pair:None})).await.unwrap();
    let request=Request::ObservePage {page_id:page};
    hello.check_request("durability",&serde_json::to_value(&request).unwrap()).unwrap();
    let observed:sumi_protocol::durability::PageObservation=serde_json::from_value(process.durable(&hello.instance,&session,request).await.unwrap()).unwrap();
    assert_eq!(observed.loaded.revision,0);
    assert!(matches!(observed.files,sumi_protocol::durability::ObservedFiles::Unwritten));
    process.raw("$deactivate",Value::Null).await.unwrap();
    assert!(process.child.wait().await.unwrap().success());
}
#[tokio::test]
#[ignore = "requires explicit SUMI_TEST_LEGACY_BINARY to the previously released executable"]
async fn real_legacy_hello_requests_plugin_update_without_blocking_fonts_or_sound() {
    let binary=std::env::var_os("SUMI_TEST_LEGACY_BINARY").expect("explicit released test binary");
    let mut legacy=Process::start_path(Path::new(&binary)).await;
    let hello:sumi_protocol::service::Hello=serde_json::from_value(legacy.service("hello",json!({"version":1})).await.unwrap()).unwrap();
    let observation=json!({"method":"observe_page","params":{"page_id":uuid::Uuid::new_v4().to_string()}});
    assert!(hello.check_request("durability",&observation).unwrap_err().contains("请更新 Sumi 插件"));
    // Production guard rejects before sending the unknown Request variant.
    // Existing service version 1 calls still work against that exact old binary.
    let temp=tempfile::tempdir().unwrap();std::fs::create_dir(temp.path().join("vault")).unwrap();
    let session=uuid::Uuid::new_v4().to_string();legacy.open(&hello.instance,&session,temp.path()).await;
    hello.check_request("fonts",&json!({"operation":"statuses"})).unwrap();
    let fonts=legacy.service("fonts",json!({"version":1,"cache":temp.path().join("fonts"),"payload":{"operation":"statuses"}})).await.unwrap();
    assert!(!fonts["statuses"].as_array().unwrap().is_empty());
    hello.check_request("sound",&json!({"operation":"status"})).unwrap();
    let sound=legacy.service("sound",json!({"instance":hello.instance,"session":session,"payload":{"operation":"status"}})).await.unwrap();
    assert_eq!(sound["ready"],false);
    legacy.raw("$deactivate",Value::Null).await.unwrap();
    assert!(legacy.child.wait().await.unwrap().success());
}
#[tokio::test]
async fn real_stdio_commit_kill_reopen_replay_and_private_boundary() {
    let temp=tempfile::tempdir().unwrap();std::fs::create_dir(temp.path().join("vault")).unwrap();
    let session=uuid::Uuid::new_v4().to_string();let page=uuid::Uuid::new_v4().to_string();
    let mut first=Process::start().await;let instance=first.hello().await;
    first.open(&instance,&session,temp.path()).await;
    first.open(&instance,&session,temp.path()).await; // same-session binding is idempotent
    let ui_error=first.raw("ui.request",json!({"method":"service.request","params":{"method":"durability","params":{}}})).await.unwrap_err();
    assert!(ui_error["message"].as_str().unwrap().contains("no ui handler"));
    assert!(first.durable(&instance,&uuid::Uuid::new_v4().to_string(),Request::List).await.is_err());
    assert!(first.durable("stale-instance",&session,Request::List).await.is_err());
    assert!(first.service("open",json!({"version":1,"instance":instance,"session":uuid::Uuid::new_v4().to_string(),"vault":temp.path().join("vault"),"database":temp.path().join("private/documents.sqlite3"),"fontCache":temp.path().join("fonts")})).await.is_err());
    let fonts=first.service("fonts",json!({"version":1,"cache":temp.path().join("fonts"),"payload":{"operation":"statuses"}})).await.unwrap();
    assert_eq!(fonts["statuses"].as_array().unwrap().len(),6);
    assert!(fonts["statuses"].as_array().unwrap().iter().all(|v|v["status"]=="not_downloaded"));
    let sound_status=first.service("sound",json!({"instance":instance,"session":session,"payload":{"operation":"status"}})).await.unwrap();
    assert_eq!(sound_status["ready"],false);
    assert!(first.service("sound",json!({"instance":instance,"session":"foreign","payload":{"operation":"status"}})).await.is_err());
    // Release acceptance unpacks the exact signed package. This opens the real
    // output device but never schedules samples or observes keyboard input.
    if std::env::var_os("SUMI_TEST_PACKAGED_SOUNDS").is_some() {
        for preset in ["typewriter","thock"] {
            let token=uuid::Uuid::new_v4().to_string();
            let deadline=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64+3000;
            let configured=first.service("sound",json!({"instance":instance,"session":session,"payload":{"operation":"configure","enabled":true,"preset":preset,"token":token,"expires_at_ms":deadline}})).await.unwrap();
            assert_eq!(configured["ready"],true);
            let stopped=first.service("sound",json!({"instance":instance,"session":session,"payload":{"operation":"configure","enabled":false,"preset":preset,"token":token}})).await.unwrap();
            assert_eq!(stopped["ready"],false);
        }
    }
    let mut document=write_core::Document::new(&page,1,19).unwrap();
    first.durable(&instance,&session,Request::Create(Create {page_id:page.clone(),epoch:1,full_state:document.encode_full(),revision:0,after_id:None,first_write_date:None,frontmatter:None,preserved_pair:None})).await.unwrap();
    let update=document.replace(0,0,0,"真实子进程：一次写入",100).unwrap();
    let edit=LocalEdit {page_id:page.clone(),epoch:1,generation:0,revision:1,op_id:uuid::Uuid::new_v4().to_string(),update,first_write_date:Some("2026-11-08".into())};
    // Deliberately never consume/accept the operation's RPC result. A separate
    // Committed event proves SQLite committed before we kill the executable.
    let lost_id=first.next;first.next+=1;
    first.send(json!({"jsonrpc":"2.0","id":lost_id,"method":"service.request","params":{"method":"durability","params":{"instance":instance,"session":session,"payload":Request::CommitLocal(edit.clone())}}})).await;
    loop {let message=first.read().await;
        if message["method"]=="host.sumi.service" && message["params"]["params"]["Committed"]["revision"]==1 {break;}
        if message.get("method").is_some(){first.acknowledge(&message).await;}
    }
    first.child.kill().await.unwrap();first.child.wait().await.unwrap();
    let mut second=Process::start().await;let restarted=second.hello().await;assert_ne!(instance,restarted);
    second.open(&restarted,&session,temp.path()).await;
    let receipt:CommitReceipt=serde_json::from_value(second.durable(&restarted,&session,Request::CommitLocal(edit.clone())).await.unwrap()).unwrap();
    assert_eq!(receipt,sumi_protocol::durability::edit_receipt(&edit,false,None).unwrap());
    second.durable(&restarted,&session,Request::Flush).await.unwrap();
    let loaded:Loaded=serde_json::from_value(second.durable(&restarted,&session,Request::Load {page_id:page.clone()}).await.unwrap()).unwrap();
    assert_eq!(loaded.revision,1);assert!(loaded.raw_markdown.ends_with("真实子进程：一次写入"));
    let outbox=second.durable(&restarted,&session,Request::Outbox).await.unwrap();
    assert_eq!(outbox.as_array().unwrap().iter().filter(|v|v["update"]["op_id"]==edit.op_id).count(),1);
    let mut changed=edit;changed.first_write_date=Some("2026-11-09".into());
    assert!(second.durable(&restarted,&session,Request::CommitLocal(changed)).await.is_err());
    second.raw("$deactivate",Value::Null).await.unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(5),second.child.wait()).await.unwrap().unwrap().success());
    // A clean shutdown releases its owner lock too.
    let reopened=notemd_sumi_backend::durability::Durability::open(temp.path().join("vault"),temp.path().join("private/documents.sqlite3"), |_|{}).await.unwrap();
    assert_eq!(reopened.load(page).await.unwrap().revision,1);
}
