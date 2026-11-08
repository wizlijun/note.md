//! Optional keyboard feedback. No keyboard access, text, or document dependency.
use crate::Result;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::Path};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize)]
#[serde(tag="operation", rename_all="snake_case", deny_unknown_fields)]
pub enum Request {
    Configure { enabled: bool, preset: String, token: String, #[serde(default)] expires_at_ms: Option<u64> },
    Play { token: String, roles: Vec<Role>, expires_at_ms: u64 },
    Stop { token: String },
    Status,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all="snake_case")]
pub enum Role { Key, Space, Enter, Delete, Modifier, KeyUp, SpaceUp }
impl Role {
    fn name(self)->&'static str {match self {Self::Key=>"key",Self::Space=>"space",Self::Enter=>"enter",Self::Delete=>"delete",Self::Modifier=>"modifier",Self::KeyUp=>"key_up",Self::SpaceUp=>"space_up"}}
}
#[derive(Serialize)]
pub struct Status { pub ready:bool }
#[derive(Deserialize)]
struct Catalog {schema:u32,packs:Vec<Pack>,assets:Vec<Asset>}
#[derive(Deserialize)]
struct Pack {id:String,roles:HashMap<String,Vec<String>>}
#[derive(Deserialize)]
struct Asset {file:String,size:u64,sha256:String}

fn bank(root:&Path,preset:&str)->Result<String> {
    if !matches!(preset,"typewriter"|"thock") {return Err("unknown typing sound".into());}
    let bytes=std::fs::read(root.join("manifest.json")).map_err(|_|"typing sound catalog missing")?;
    if bytes.len()>64*1024 {return Err("typing sound catalog too large".into());}
    let catalog:Catalog=serde_json::from_slice(&bytes).map_err(|_|"invalid typing sound catalog")?;
    if catalog.schema!=1 {return Err("unsupported typing sound catalog".into());}
    let pack=catalog.packs.iter().find(|p|p.id==preset).ok_or("typing sound preset missing")?;
    let mut result=HashMap::<String,Vec<String>>::new();
    for role in [Role::Key,Role::Space,Role::Enter,Role::Delete,Role::Modifier,Role::KeyUp,Role::SpaceUp] {
        let catalog_role=match role {Role::KeyUp=>"keyUp",Role::SpaceUp=>"spaceUp",_=>role.name()};
        let names=pack.roles.get(catalog_role).ok_or("typing sound role missing")?;
        if names.len()>16 {return Err("too many typing sound samples".into());}
        let mut files=Vec::new();
        for name in names {
            let relative=Path::new(name);
            if relative.is_absolute() || relative.components().count()!=2 || relative.components().any(|p|!matches!(p,std::path::Component::Normal(_))) || !name.starts_with(&format!("{preset}/")) {
                return Err("invalid typing sound asset path".into());
            }
            let asset=catalog.assets.iter().find(|a|a.file==*name).ok_or("unlisted typing sound asset")?;
            let path=root.join(relative);
            if path.symlink_metadata().map_err(crate::err)?.file_type().is_symlink() || root.join(preset).symlink_metadata().map_err(crate::err)?.file_type().is_symlink() {return Err("linked typing sound asset refused".into());}
            if asset.size>2*1024*1024 || std::fs::metadata(&path).map_err(crate::err)?.len()!=asset.size {return Err("typing sound asset size mismatch".into());}
            let raw=std::fs::read(&path).map_err(crate::err)?;
            if format!("{:x}",Sha256::digest(&raw))!=asset.sha256 {return Err("typing sound asset checksum mismatch".into());}
            files.push(path.to_str().ok_or("typing sound path is not UTF-8")?.to_owned());
        }
        result.insert(role.name().into(),files);
    }
    serde_json::to_string(&result).map_err(crate::err)
}

fn live_deadline(deadline:u64,max_ahead:u64)->bool {
    let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    deadline>=now && deadline<=now.saturating_add(max_ahead)
}

#[derive(Default)]
pub struct Manager { engine:Option<Engine>, binding:Option<(String,String)>, preset:String }
impl Manager {
    pub fn request(&mut self,session:&str,request:Request)->Result<Status> {
        self.request_at(session,request,None)
    }
    fn request_at(&mut self,session:&str,request:Request,root:Option<&Path>)->Result<Status> {
        match request {
            Request::Configure{enabled,preset,token,expires_at_ms}=>{
                if !matches!(preset.as_str(),"typewriter"|"thock") || uuid::Uuid::parse_str(&token).is_err() {return Err("invalid typing sound configuration".into());}
                if !enabled {
                    // A delayed cleanup from an old surface/workspace must not stop its successor.
                    if self.binding.as_ref().is_some_and(|(owner,current)|owner==session && current==&token) {
                        self.binding=None;self.engine=None;
                    }
                    return Ok(Status{ready:self.binding.as_ref().is_some_and(|(owner,_)|owner==session) && self.engine.as_ref().is_some_and(Engine::ready)});
                }
                let deadline=expires_at_ms.ok_or("typing sound configuration deadline missing")?;
                if !live_deadline(deadline,5000) {return Err("typing sound configuration expired".into());}
                if let Some(engine)=&self.engine {engine.stop();}
                self.binding=None;
                if self.engine.as_ref().is_none_or(|e|!e.ready()) || self.preset!=preset {
                    self.engine=None;
                    let installed=std::env::current_exe().map_err(crate::err)?.parent().and_then(Path::parent).ok_or("plugin resource directory unavailable")?.join("resources/sounds");
                    self.engine=Some(Engine::new(&bank(root.unwrap_or(&installed),&preset)?,false)?);
                    self.preset=preset;
                }
                if !live_deadline(deadline,5000) {self.engine=None;return Err("typing sound configuration expired".into());}
                self.binding=Some((session.into(),token));
            }
            Request::Play{token,roles,expires_at_ms}=>{
                if roles.len()>32 {return Err("typing sound batch too large".into());}
                if live_deadline(expires_at_ms,200) && self.binding.as_ref().is_some_and(|(owner,current)|owner==session && current==&token) {
                    if let Some(engine)=&self.engine {for role in roles {engine.play(role);}}
                }
            }
            Request::Stop{token}=>{
                if self.binding.as_ref().is_some_and(|(owner,current)|owner==session && current==&token) {
                    if let Some(engine)=&self.engine {engine.stop();}
                }
            }
            Request::Status=>{}
        }
        Ok(Status{ready:self.binding.as_ref().is_some_and(|(owner,_)|owner==session) && self.engine.as_ref().is_some_and(Engine::ready)})
    }
    pub fn shutdown(&mut self) {self.binding=None;self.engine=None;}
}

#[cfg(target_os="macos")]
mod platform {
    use super::*;
    use std::ffi::{c_char,c_void,CStr,CString};
    unsafe extern "C" {
        fn sumi_sound_create(bank:*const c_char,offline:i32,error:*mut *mut c_char)->*mut c_void;
        fn sumi_sound_ready(context:*mut c_void)->i32;
        fn sumi_sound_play(context:*mut c_void,role:*const c_char);
        fn sumi_sound_stop(context:*mut c_void);
        fn sumi_sound_destroy(context:*mut c_void);
        fn sumi_sound_free(value:*mut c_char);
        #[cfg(test)] fn sumi_sound_render(context:*mut c_void,frames:u32,peak:*mut f32,voices:*mut u32)->i32;
    }
    pub struct Engine(*mut c_void);
    // Native object owns one serial dispatch queue. Every entry synchronizes or enqueues there.
    unsafe impl Send for Engine {}
    impl Engine {
        pub fn new(bank:&str,offline:bool)->Result<Self> {
            let bank=CString::new(bank).map_err(crate::err)?;let mut error=std::ptr::null_mut();
            let context=unsafe{sumi_sound_create(bank.as_ptr(),i32::from(offline),&mut error)};
            if context.is_null() {
                let message=if error.is_null(){"audio output unavailable".into()}else{unsafe{let value=CStr::from_ptr(error).to_string_lossy().into_owned();sumi_sound_free(error);value}};
                return Err(message);
            }
            Ok(Self(context))
        }
        pub fn ready(&self)->bool {unsafe{sumi_sound_ready(self.0)!=0}}
        pub fn play(&self,role:Role) {let name=CString::new(role.name()).unwrap();unsafe{sumi_sound_play(self.0,name.as_ptr())}}
        pub fn stop(&self) {unsafe{sumi_sound_stop(self.0)}}
        #[cfg(test)] pub fn render(&self)->(f32,u32) {let(mut peak,mut voices)=(0.,0);assert_eq!(unsafe{sumi_sound_render(self.0,4096,&mut peak,&mut voices)},1);(peak,voices)}
    }
    impl Drop for Engine {fn drop(&mut self){unsafe{sumi_sound_destroy(self.0)}}}
}
#[cfg(not(target_os="macos"))]
mod platform {
    use super::*;
    pub struct Engine;
    impl Engine {
        pub fn new(_:&str,_:bool)->Result<Self>{Err("typing sounds require macOS".into())}
        pub fn ready(&self)->bool{false}
        pub fn play(&self,_:Role){}
        pub fn stop(&self){}
    }
}
use platform::Engine;

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    fn deadline()->u64 {(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64)+150}
    fn resources()->PathBuf {PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/sounds")}
    #[test]
    fn bundled_banks_are_verified_and_release_does_not_fall_back_to_press() {
        let typewriter:serde_json::Value=serde_json::from_str(&bank(&resources(),"typewriter").unwrap()).unwrap();
        assert_eq!(typewriter["key_up"],serde_json::json!([]));assert_eq!(typewriter["space_up"],serde_json::json!([]));
        let thock:serde_json::Value=serde_json::from_str(&bank(&resources(),"thock").unwrap()).unwrap();
        assert_eq!(thock["key_up"],thock["space_up"]);assert_eq!(thock["key_up"].as_array().unwrap().len(),1);
        assert!(bank(&resources(),"../typewriter").is_err());
    }
    #[test]
    fn malformed_requests_and_unknown_roles_are_rejected_without_starting_audio() {
        for value in [serde_json::json!({"operation":"play","token":"t","roles":["text"]}),serde_json::json!({"operation":"configure","enabled":true,"preset":"typewriter","token":"t","characters":"private"})] {
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
        let mut manager=Manager::default();
        assert!(!manager.request("s",Request::Play{token:"stale".into(),roles:vec![Role::Key],expires_at_ms:deadline()}).unwrap().ready);
        assert!(manager.request("s",Request::Configure{enabled:true,preset:"unknown".into(),token:uuid::Uuid::new_v4().to_string(),expires_at_ms:None}).is_err());
        assert!(manager.request("s",Request::Configure{enabled:true,preset:"typewriter".into(),token:uuid::Uuid::new_v4().to_string(),expires_at_ms:Some(0)}).is_err());
        assert!(manager.request("s",Request::Play{token:"t".into(),roles:vec![Role::Key;33],expires_at_ms:deadline()}).is_err());
    }
    #[cfg(target_os="macos")]
    #[test]
    fn sessions_tokens_disable_and_stop_fence_audio_without_touching_documents() {
        let token=uuid::Uuid::new_v4().to_string();
        let mut manager=Manager {engine:Some(Engine::new(&bank(&resources(),"thock").unwrap(),true).unwrap()),binding:Some(("owner".into(),token.clone())),preset:"thock".into()};
        assert!(manager.request("old",Request::Configure{enabled:true,preset:"typewriter".into(),token:uuid::Uuid::new_v4().to_string(),expires_at_ms:Some(0)}).is_err());
        assert_eq!(manager.binding,Some(("owner".into(),token.clone())));assert_eq!(manager.preset,"thock");assert!(manager.engine.as_ref().unwrap().ready());
        for (session,key) in [("other",token.as_str()),("owner","stale")] {
            manager.request(session,Request::Play{token:key.into(),roles:vec![Role::Key],expires_at_ms:deadline()}).unwrap();
        }
        manager.request("owner",Request::Play{token:token.clone(),roles:vec![Role::Key],expires_at_ms:0}).unwrap();
        manager.request("owner",Request::Play{token:token.clone(),roles:vec![Role::Key],expires_at_ms:u64::MAX}).unwrap();
        assert_eq!(manager.engine.as_ref().unwrap().render().1,0);
        manager.request("owner",Request::Play{token:token.clone(),roles:vec![Role::Key],expires_at_ms:deadline()}).unwrap();
        assert_eq!(manager.engine.as_ref().unwrap().render().1,1);
        manager.request("other",Request::Stop{token:token.clone()}).unwrap();
        manager.request("owner",Request::Stop{token:token.clone()}).unwrap();
        assert!(manager.engine.as_ref().unwrap().render().0<0.0001);
        manager.request("other",Request::Configure{enabled:false,preset:"thock".into(),token:token.clone(),expires_at_ms:None}).unwrap();
        manager.request("owner",Request::Configure{enabled:false,preset:"thock".into(),token:uuid::Uuid::new_v4().to_string(),expires_at_ms:None}).unwrap();
        assert!(manager.engine.is_some() && manager.binding.is_some());
        manager.request("owner",Request::Configure{enabled:false,preset:"thock".into(),token:token.clone(),expires_at_ms:None}).unwrap();
        assert!(manager.engine.is_none() && manager.binding.is_none());
        assert!(!manager.request("owner",Request::Play{token,roles:vec![Role::Key],expires_at_ms:deadline()}).unwrap().ready);
    }
    #[test]
    fn tampered_asset_is_rejected_before_audio_engine_creation() {
        let temp=tempfile::tempdir().unwrap();
        std::fs::copy(resources().join("manifest.json"),temp.path().join("manifest.json")).unwrap();
        std::fs::create_dir(temp.path().join("typewriter")).unwrap();
        for entry in std::fs::read_dir(resources().join("typewriter")).unwrap() {
            let entry=entry.unwrap();std::fs::copy(entry.path(),temp.path().join("typewriter").join(entry.file_name())).unwrap();
        }
        let path=temp.path().join("typewriter/typewriter-keys-1.wav");
        let mut raw=std::fs::read(&path).unwrap();raw[50]^=1;std::fs::write(path,raw).unwrap();
        assert!(bank(temp.path(),"typewriter").unwrap_err().contains("checksum"));
    }
    #[cfg(target_os="macos")]
    #[test]
    fn real_audio_decodes_renders_overlap_and_stops_without_system_playback() {
        for preset in ["typewriter","thock"] {
            let engine=Engine::new(&bank(&resources(),preset).unwrap(),true).unwrap();
            assert!(engine.ready());
            engine.play(Role::Key);engine.play(Role::Space);engine.play(Role::Enter);
            let (peak,voices)=engine.render();assert!(peak>0.001,"{preset} is silent");assert_eq!(voices,3);
            for _ in 0..30 {engine.play(Role::Key);}
            let (peak,voices)=engine.render();assert!(peak>0.001);assert_eq!(voices,33);
            engine.stop();let (peak,_)=engine.render();assert!(peak<0.0001,"stop retained voices");
        }
    }
    #[cfg(target_os="macos")]
    #[test]
    fn missing_release_sample_is_silent_and_thock_release_is_a_real_sample() {
        for (preset,expected) in [("typewriter",0),("thock",2)] {
            let engine=Engine::new(&bank(&resources(),preset).unwrap(),true).unwrap();
            engine.play(Role::KeyUp);engine.play(Role::SpaceUp);
            let (peak,voices)=engine.render();assert_eq!(voices,expected);assert_eq!(peak>0.0001,expected>0);
        }
    }
}
