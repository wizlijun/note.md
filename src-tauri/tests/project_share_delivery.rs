//! Explicit synthetic-fixture recorder. Never reads application settings or a user Vault.
use notemd_lib::project_share::{ProjectStore, FeedbackEnvelope};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::PathBuf};

#[test]
#[ignore = "requires an explicit marked synthetic fixture and request/output paths"]
fn record_project_share_delivery() {
    let root = PathBuf::from(std::env::var("NOTEMD_DELIVERY_ROOT").expect("explicit fixture root required")).canonicalize().unwrap();
    assert_eq!(fs::read_to_string(root.join(".notemd-delivery-fixture")).unwrap(), "synthetic-project-share-task8\n");
    let request_path = PathBuf::from(std::env::var("NOTEMD_DELIVERY_REQUEST").expect("request required")).canonicalize().unwrap();
    assert!(request_path.starts_with(&root));
    let request: Value = serde_json::from_slice(&fs::read(request_path).unwrap()).unwrap();
    let output = root.join(request["output"].as_str().unwrap());
    assert!(output.parent().unwrap().canonicalize().unwrap().starts_with(&root));
    assert!(!output.exists(), "recordings must never overwrite earlier results");
    for path in ["vault", "state", "source"] { assert!(root.join(path).canonicalize().unwrap().starts_with(&root)); }
    let service = ProjectStore::new(root.join("vault"), root.join("state"));
    let info = service.open(root.join("source").to_str().unwrap(), "README.md").unwrap();
    let id = &info.project_id;
    let result = match request["op"].as_str().unwrap() {
        "freeze" => {
            let paths: Vec<String> = serde_json::from_value(request["paths"].clone()).unwrap();
            assert!(paths.iter().all(|p| ["README.md", "docs/note.md", "pixel.png"].contains(&p.as_str())));
            let hashes: BTreeMap<_,_> = paths.iter().map(|p| (p.clone(), service.read(id,p).unwrap().hash)).collect();
            let snapshot = service.snapshot(id, paths, hashes).unwrap();
            json!({"info":info,"snapshot":snapshot})
        },
        "bundle" => {
            let path = root.join(request["htmlFile"].as_str().unwrap()).canonicalize().unwrap();
            assert!(path.starts_with(&root));
            service.bundle(id, request["snapshotId"].as_str().unwrap(), &fs::read_to_string(path).unwrap()).unwrap();
            Value::Null
        },
        "published" => json!(service.published(id,request["snapshotId"].as_str().unwrap(),request["url"].as_str().unwrap()).unwrap()),
        "review" => {
            let envelope_path = root.join(request["envelopeFile"].as_str().unwrap()).canonicalize().unwrap();
            assert!(envelope_path.starts_with(&root));
            let envelope: FeedbackEnvelope = serde_json::from_slice(&fs::read(envelope_path).unwrap()).unwrap();
            let feedback = service.feedback(id,envelope).unwrap();
            let submission = feedback.envelope.payload.submission_id();
            let review = service.review(id, submission, "README.md").unwrap();
            json!({"feedback":feedback,"review":review})
        },
        "apply" => {
            let sid=request["submissionId"].as_str().unwrap();
            let draft=serde_json::from_value(request["draft"].clone()).unwrap();
            service.review_save(id,sid,"README.md",draft).unwrap();
            let feedback=service.apply(id,sid,"README.md",request["expectedHash"].as_str().unwrap(),request["content"].as_str().unwrap(),Some(serde_json::from_value(request["summary"].clone()).unwrap())).unwrap();
            let raw=fs::read(root.join("source/README.md")).unwrap();
            assert_eq!(raw,request["content"].as_str().unwrap().as_bytes());
            json!({"feedback":feedback,"readback":service.read(id,"README.md").unwrap()})
        },
        _ => panic!("unknown recording operation"),
    };
    use std::io::Write;
    let mut file=fs::OpenOptions::new().write(true).create_new(true).open(output).unwrap();
    file.write_all(&serde_json::to_vec_pretty(&result).unwrap()).unwrap(); file.sync_all().unwrap();
    println!("Recorded actual ProjectStore {} for synthetic project {}",request["op"],id);
}
