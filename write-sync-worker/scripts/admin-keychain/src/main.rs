use std::{fs::{self,OpenOptions},io::Write,os::unix::fs::OpenOptionsExt};
fn main()->Result<(),Box<dyn std::error::Error>> {
 let args:Vec<String>=std::env::args().collect();let mode=args.get(1).ok_or("mode")?;let path=args.get(2).ok_or("private path")?;
 let service="net.notemd.sumi.admin.v1";let account="cloudflare:sumi-sync";
 match mode.as_str() {
  "put"=>{let data=fs::read(path)?;let _:serde_json::Value=serde_json::from_slice(&data)?;security_framework::passwords::set_generic_password(service,account,&data)?;println!("Admin bundle stored in Keychain");},
  "get"=>{let data=security_framework::passwords::get_generic_password(service,account)?;let mut f=OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;f.write_all(&data)?;f.sync_all()?;println!("Admin bundle written to private file");},
  _=>return Err("invalid mode".into())
 };Ok(())
}
