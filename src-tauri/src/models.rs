mod credentials;

use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{redirect::Policy, Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        LazyLock, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;
use url::Url;

#[derive(Debug, Serialize)]
pub struct ModelError {
    code: &'static str,
    message: &'static str,
}
type ModelResult<T> = Result<T, ModelError>;
fn error(code: &'static str, message: &'static str) -> ModelError {
    ModelError { code, message }
}
fn storage_error() -> ModelError {
    error(
        "storage",
        "无法读写模型设置，请检查应用数据目录的访问权限。",
    )
}
fn format_error() -> ModelError {
    error(
        "response",
        "服务返回了无法识别的内容，请检查接口地址和模型名称。",
    )
}
fn cancelled() -> ModelError {
    error("cancelled", "已取消本次操作。")
}

#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Text,
    Image,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    id: String,
    name: String,
    endpoint: String,
    model: String,
    vision: bool,
    #[serde(default)]
    provider: String,
    #[serde(default)]
    has_key: bool,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Action {
    id: String,
    name: String,
    input: Kind,
    prompt: String,
    #[serde(default, rename = "modelId")]
    model_id: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    revision: u64,
    profiles: Vec<Profile>,
    default_text: Option<String>,
    default_vision: Option<String>,
    actions: Vec<Action>,
}

#[derive(Clone, Deserialize, Serialize)]
struct KeyRef {
    target: String,
    endpoint: String,
}

#[derive(Deserialize, Serialize)]
struct Store {
    settings: Settings,
    keys: HashMap<String, KeyRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    retired_keys: Vec<String>,
}

static BUILT_INS: LazyLock<Vec<Action>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../src/models/defaults.json"))
        .expect("built-in action definitions")
});

fn required_actions() -> impl Iterator<Item = &'static Action> {
    BUILT_INS
        .iter()
        .filter(|a| matches!(a.id.as_str(), "translate" | "image-translate" | "ocr"))
}

fn restore_required_actions(settings: &mut Settings) {
    for required in required_actions() {
        if let Some(saved) = settings.actions.iter_mut().find(|a| a.id == required.id) {
            if saved.input != required.input {
                saved.input = required.input;
                saved.model_id = None;
            }
        } else {
            settings.actions.push(required.clone());
        }
    }
}

impl Default for Store {
    fn default() -> Self {
        Self {
            settings: Settings {
                revision: 0,
                profiles: Vec::new(),
                default_text: None,
                default_vision: None,
                actions: BUILT_INS.clone(),
            },
            keys: HashMap::new(),
            retired_keys: Vec::new(),
        }
    }
}

static SETTINGS_LOCK: Mutex<()> = Mutex::new(());
static NEXT: AtomicU64 = AtomicU64::new(0);

fn unique_id() -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{stamp:x}-{:x}-{:x}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

fn settings_path(app: &AppHandle) -> ModelResult<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|_| storage_error())?
        .join("model-settings.json"))
}

fn load(path: &Path) -> ModelResult<Store> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(|mut store: Store| {
                restore_required_actions(&mut store.settings);
                store
            })
            .map_err(|_| {
                error(
                    "storage",
                    "模型设置文件无法解析，请检查 model-settings.json。",
                )
            }),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Store::default()),
        Err(_) => Err(storage_error()),
    }
}

fn store_file(path: &Path, store: &Store) -> ModelResult<()> {
    let temp = path.with_extension(format!("{}.tmp", unique_id()));
    let bytes = serde_json::to_vec_pretty(store).map_err(|_| storage_error())?;
    let save = || -> io::Result<()> {
        fs::create_dir_all(path.parent().ok_or(io::ErrorKind::InvalidInput)?)?;
        let mut file = fs::File::create_new(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    };
    save().map_err(|_| {
        let _ = fs::remove_file(temp);
        storage_error()
    })
}

fn endpoint_url(raw: &str) -> ModelResult<Url> {
    let invalid = || {
        error(
            "endpoint",
            "请输入完整的 HTTP 或 HTTPS 接口地址，地址中不能包含账号、密码、查询参数或片段。",
        )
    };
    let mut url = Url::parse(raw.trim()).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.has_host()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    let path = url.path().trim_end_matches('/');
    let full_path = if path.ends_with("/chat/completions") {
        path.to_owned()
    } else {
        format!("{path}/chat/completions")
    };
    url.set_path(&full_path);
    Ok(url)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn validate(settings: &Settings) -> ModelResult<()> {
    if required_actions().any(|required| {
        !settings
            .actions
            .iter()
            .any(|a| a.id == required.id && a.input == required.input)
    }) {
        return Err(error(
            "action",
            "翻译与提取文字是系统入口所需的内置动作，请保留其输入类型。",
        ));
    }
    let mut ids = HashSet::new();
    for profile in &settings.profiles {
        if !valid_id(&profile.id)
            || !ids.insert(&profile.id)
            || profile.name.trim().is_empty()
            || profile.model.trim().is_empty()
        {
            return Err(error("profile", "请为每个模型填写名称和模型 ID。"));
        }
        endpoint_url(&profile.endpoint)?;
    }
    for (id, vision) in [
        (&settings.default_text, false),
        (&settings.default_vision, true),
    ] {
        if let Some(id) = id {
            if !settings
                .profiles
                .iter()
                .any(|p| &p.id == id && (!vision || p.vision))
            {
                return Err(error("profile", "请重新选择可用的默认模型。"));
            }
        }
    }
    ids.clear();
    for action in &settings.actions {
        if !valid_id(&action.id)
            || !ids.insert(&action.id)
            || action.name.trim().is_empty()
            || action.prompt.trim().is_empty()
        {
            return Err(error("action", "请填写快捷操作的名称与提示词。"));
        }
        if action.model_id.as_ref().is_some_and(|id| {
            !settings
                .profiles
                .iter()
                .any(|p| &p.id == id && (action.input != Kind::Image || p.vision))
        }) {
            return Err(error("profile", "此操作需要一个支持相应输入类型的模型。"));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn model_settings_load(app: AppHandle) -> ModelResult<Settings> {
    let _guard = SETTINGS_LOCK.lock().map_err(|_| storage_error())?;
    Ok(load(&settings_path(&app)?)?.settings)
}

#[tauri::command]
pub async fn model_settings_save(
    app: AppHandle,
    mut settings: Settings,
    key_changes: HashMap<String, Option<String>>,
) -> ModelResult<Settings> {
    let _guard = SETTINGS_LOCK.lock().map_err(|_| storage_error())?;
    validate(&settings)?;
    let path = settings_path(&app)?;
    let old = load(&path)?;
    if old.settings.revision != settings.revision {
        return Err(error(
            "conflict",
            "设置已在另一个窗口更新，请重新载入后再保存。",
        ));
    }
    let mut keys = HashMap::new();
    let mut added = Vec::new();
    let transaction = || -> ModelResult<Store> {
        for profile in &mut settings.profiles {
            let endpoint = endpoint_url(&profile.endpoint)?.to_string();
            let key_ref = match key_changes.get(&profile.id) {
                Some(Some(key)) if !key.is_empty() => {
                    if key.len() > 2560 || !key.bytes().all(|b| b.is_ascii_graphic()) {
                        return Err(error(
                            "credential",
                            "密钥包含空格、无效字符或超过凭据存储限制。",
                        ));
                    }
                    let target = unique_id();
                    credentials::write(&target, key)?;
                    added.push(target.clone());
                    Some(KeyRef { target, endpoint })
                }
                Some(_) => None,
                None => old
                    .keys
                    .get(&profile.id)
                    .filter(|k| k.endpoint == endpoint)
                    .cloned(),
            };
            profile.has_key = key_ref.is_some();
            if let Some(key_ref) = key_ref {
                keys.insert(profile.id.clone(), key_ref);
            }
        }
        settings.revision += 1;
        // Keep the cleanup list in the same commit as the configuration. A locked
        // credential vault or a process exit after rename can be retried on save.
        let mut retired_keys: Vec<_> = old
            .retired_keys
            .iter()
            .filter(|target| credentials::delete(target).is_err())
            .cloned()
            .collect();
        for (id, old_ref) in &old.keys {
            if keys.get(id).map(|r| &r.target) != Some(&old_ref.target) {
                retired_keys.push(old_ref.target.clone());
            }
        }
        let store = Store {
            settings,
            keys,
            retired_keys,
        };
        store_file(&path, &store)?;
        Ok(store)
    };
    let store = match transaction() {
        Ok(store) => store,
        Err(e) => {
            for target in added {
                let _ = credentials::delete(&target);
            }
            return Err(e);
        }
    };
    for target in &store.retired_keys {
        let _ = credentials::delete(target);
    }
    Ok(store.settings)
}

#[derive(Deserialize)]
pub struct ActionInput {
    kind: Kind,
    value: String,
}

fn content(input: ActionInput) -> ModelResult<Value> {
    match input.kind {
        Kind::Text if !input.value.trim().is_empty() && input.value.len() <= 1024 * 1024 => {
            Ok(Value::String(input.value))
        }
        Kind::Text => Err(error("input", "请输入非空文本，每次最多处理 1 MB。")),
        Kind::Image => {
            let (prefix, data) = input.value.split_once(',').unwrap_or_default();
            let invalid = || error("input", "请选择 12 MB 以内的 PNG、JPEG 或 WebP 图片。");
            if data.is_empty() || data.len() > 16 * 1024 * 1024 {
                return Err(invalid());
            }
            let bytes = STANDARD.decode(data).map_err(|_| invalid())?;
            let matches_format = match prefix {
                "data:image/png;base64" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
                "data:image/jpeg;base64" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
                "data:image/webp;base64" => {
                    bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP")
                }
                _ => false,
            };
            if !matches_format {
                return Err(invalid());
            }
            Ok(json!([{"type":"image_url","image_url":{"url":input.value}}]))
        }
    }
}

struct Call {
    url: Url,
    key: Option<String>,
    model: String,
    prompt: String,
}

fn model_for_action<'a>(settings: &'a Settings, action: &Action) -> Option<&'a Profile> {
    let default = match action.input {
        Kind::Text => &settings.default_text,
        Kind::Image => &settings.default_vision,
    };
    [&action.model_id, default]
        .into_iter()
        .flatten()
        .find_map(|id| {
            settings
                .profiles
                .iter()
                .find(|p| &p.id == id && (action.input != Kind::Image || p.vision))
        })
}

fn resolve_call(app: &AppHandle, action_id: &str, kind: Kind) -> ModelResult<Call> {
    let _guard = SETTINGS_LOCK.lock().map_err(|_| storage_error())?;
    let store = load(&settings_path(app)?)?;
    let action = store
        .settings
        .actions
        .iter()
        .find(|a| a.id == action_id && a.input == kind)
        .ok_or_else(|| error("action", "此快捷操作不可用于当前内容。"))?;
    let profile = model_for_action(&store.settings, action).ok_or_else(|| {
        error(
            "unconfigured",
            match kind {
                Kind::Text => "请先在模型设置中选择默认文本模型。",
                Kind::Image => "请先在模型设置中选择支持图片的默认视觉模型。",
            },
        )
    })?;
    let url = endpoint_url(&profile.endpoint)?;
    let key = store
        .keys
        .get(&profile.id)
        .filter(|k| k.endpoint == url.as_str())
        .map(|k| credentials::read(&k.target))
        .transpose()?;
    Ok(Call {
        url,
        key,
        model: profile.model.trim().to_owned(),
        prompt: action.prompt.clone(),
    })
}

fn network_error(err: reqwest::Error) -> ModelError {
    if err.is_timeout() {
        error("timeout", "模型响应超时，请稍后重试。")
    } else {
        error("network", "连接模型服务失败，请检查接口地址与网络连接。")
    }
}

async fn request(call: Call, input: ActionInput) -> ModelResult<String> {
    let body = json!({ "model":call.model,"stream":false,"messages":[{"role":"system","content":call.prompt},{"role":"user","content":content(input)?}] });
    let mut builder = Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(90))
        .connect_timeout(Duration::from_secs(12));
    if call.url.scheme() == "http" {
        builder = builder.no_proxy();
    }
    let client = builder.build().map_err(network_error)?;
    let mut req = client.post(call.url).json(&body);
    if let Some(key) = call.key {
        req = req.bearer_auth(key);
    }
    let mut response = req.send().await.map_err(network_error)?;
    if !response.status().is_success() {
        return Err(match response.status() {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                error("auth", "服务拒绝了请求，请检查 API 密钥与模型权限。")
            }
            StatusCode::TOO_MANY_REQUESTS => {
                error("rate_limit", "已达到服务的请求或配额限制，请稍后重试。")
            }
            StatusCode::NOT_FOUND => {
                error("endpoint", "未找到模型或接口，请检查模型 ID 与接口地址。")
            }
            StatusCode::PAYLOAD_TOO_LARGE => {
                error("input", "内容超过服务限制，请缩小图片或缩短文字。")
            }
            s if s.is_server_error() => error("provider", "模型服务暂时不可用，请稍后重试。"),
            s if s.is_redirection() => {
                error("endpoint", "服务返回重定向，请将最终地址直接填入模型配置。")
            }
            _ => error(
                "provider",
                "服务未接受请求，请检查接口与输入是否受此模型支持。",
            ),
        });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err(error("response", "模型输出过长，请缩短输入或提示词。"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let result: Value = serde_json::from_slice(&bytes).map_err(|_| format_error())?;
    let value = result
        .pointer("/choices/0/message/content")
        .ok_or_else(format_error)?;
    let result = match value {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => return Err(format_error()),
    };
    if result.trim().is_empty() {
        return Err(error("response", "模型没有返回文字，请调整提示词后重试。"));
    }
    Ok(result)
}

// IPC cancellation can reach the runtime before its corresponding run is registered.
#[derive(Default)]
struct Requests {
    active: HashMap<String, oneshot::Sender<()>>,
    early: HashMap<String, Instant>,
}
static REQUESTS: LazyLock<Mutex<Requests>> = LazyLock::new(Default::default);

#[tauri::command]
pub async fn model_action_run(
    app: AppHandle,
    request_id: String,
    action_id: String,
    input: ActionInput,
) -> ModelResult<String> {
    if !valid_id(&request_id) {
        return Err(error("input", "操作编号无效。"));
    }
    let (sender, receiver) = oneshot::channel();
    {
        let mut requests = REQUESTS.lock().map_err(|_| storage_error())?;
        if requests.early.remove(&request_id).is_some() {
            return Err(cancelled());
        }
        if requests.active.contains_key(&request_id) {
            return Err(error("conflict", "本次操作已在执行。"));
        }
        requests.active.insert(request_id.clone(), sender);
    }
    let work = async { request(resolve_call(&app, &action_id, input.kind)?, input).await };
    let result =
        tokio::select! { biased; _ = receiver => Err(cancelled()), result = work => result };
    REQUESTS
        .lock()
        .map_err(|_| storage_error())?
        .active
        .remove(&request_id);
    result
}

#[tauri::command]
pub async fn model_action_cancel(request_id: String) -> ModelResult<()> {
    if !valid_id(&request_id) {
        return Ok(());
    }
    let mut requests = REQUESTS.lock().map_err(|_| storage_error())?;
    if let Some(sender) = requests.active.remove(&request_id) {
        let _ = sender.send(());
    } else {
        requests
            .early
            .retain(|_, at| at.elapsed() < Duration::from_secs(30));
        requests.early.insert(request_id, Instant::now());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read};
    use std::net::TcpListener;

    #[tokio::test]
    async fn submits_one_explicit_message_to_local_compatible_service() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = endpoint_url(&format!("http://{}/v1", listener.local_addr().unwrap())).unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(&stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("POST /v1/chat/completions "));
            let mut length = None;
            loop {
                line.clear();
                reader.read_line(&mut line).unwrap();
                if line.trim_end().is_empty() {
                    break;
                }
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("Content-Length") {
                        length = Some(value.trim().parse::<usize>().unwrap());
                    }
                }
            }
            let mut body = vec![0; length.unwrap()];
            reader.read_exact(&mut body).unwrap();
            let input: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(input["model"], "offline-test");
            assert_eq!(input["messages"][0]["content"], "摘要");
            assert_eq!(input["messages"][1]["content"], "测试文字");
            let response = r#"{"choices":[{"message":{"content":"测试通过"}}]}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
        });
        let call = Call {
            url,
            key: None,
            model: "offline-test".into(),
            prompt: "摘要".into(),
        };
        let text = request(
            call,
            ActionInput {
                kind: Kind::Text,
                value: "测试文字".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(text, "测试通过");
        server.join().unwrap();
    }

    #[test]
    fn accepts_http_and_https_model_endpoints() {
        for good in [
            "https://example.com/v1",
            "http://192.0.2.42:33333/v1",
            "http://example.com:8080/v1/chat/completions",
            "http://localhost:11434/v1",
            "http://127.0.0.1:1234/v1",
            "http://[::1]/v1/chat/completions/",
        ] {
            assert!(endpoint_url(good)
                .unwrap()
                .path()
                .ends_with("/v1/chat/completions"));
        }
        for bad in [
            "http://user:secret@example.com/v1",
            "http://example.com/v1#fragment",
            "https://key@example.com",
            "https://example.com/?key=a",
            "file:///a",
        ] {
            assert!(endpoint_url(bad).is_err());
        }
    }

    #[test]
    fn restores_required_editor_actions_and_preserves_custom_prompts() {
        let mut settings = Store::default().settings;
        settings.actions.retain(|a| a.id != "image-translate");
        let ocr = settings.actions.iter_mut().find(|a| a.id == "ocr").unwrap();
        ocr.input = Kind::Text;
        ocr.prompt = "我的识别提示词".into();
        assert!(validate(&settings).is_err());
        restore_required_actions(&mut settings);
        assert!(validate(&settings).is_ok());
        assert!(settings
            .actions
            .iter()
            .any(|a| a.id == "ocr" && a.input == Kind::Image && a.prompt == "我的识别提示词"));
        assert!(settings
            .actions
            .iter()
            .any(|a| a.id == "image-translate" && a.input == Kind::Image));
    }

    #[test]
    fn only_local_images_are_accepted() {
        for value in [
            "https://example.com/private.png",
            "data:text/html;base64,AAAA",
            "data:image/png;base64,@@@@",
            "data:image/webp;base64,AAAA",
        ] {
            assert!(content(ActionInput {
                kind: Kind::Image,
                value: value.to_owned()
            })
            .is_err());
        }
        assert!(content(ActionInput {
            kind: Kind::Image,
            value: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6YkAAAAASUVORK5CYII=".into()
        })
        .is_ok());
    }

    #[test]
    fn action_specific_profile_is_used_if_compatible_then_falls_back_to_default() {
        let mut settings = Store::default().settings;
        for (id, vision) in [("text", false), ("vision-a", true), ("vision-b", true)] {
            settings.profiles.push(Profile {
                id: id.into(),
                name: id.into(),
                endpoint: "http://localhost/v1".into(),
                model: id.into(),
                vision,
                provider: "custom".into(),
                has_key: false,
            });
        }
        settings.default_vision = Some("vision-a".into());
        let mut action = settings
            .actions
            .iter()
            .find(|a| a.id == "ocr")
            .unwrap()
            .clone();
        for (id, expected) in [
            ("vision-b", "vision-b"),
            ("text", "vision-a"),
            ("removed", "vision-a"),
        ] {
            action.model_id = Some(id.into());
            assert_eq!(model_for_action(&settings, &action).unwrap().id, expected);
        }
    }
}
