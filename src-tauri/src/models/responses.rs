use super::{error, format_error, ActionInput, Call, Kind, ModelResult};
use serde_json::{json, Value};
use url::Url;

pub(super) fn chat_endpoint_rejected(body: &[u8]) -> bool {
    let Ok(body) = serde_json::from_slice::<Value>(body) else {
        return false;
    };
    let message = body
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("");
    // The gateway rejects the route before starting inference. Never replay
    // a timeout, a generic 500, or a failure after output has started.
    let reason = message.split(" (request id:").next().unwrap_or("").trim();
    reason == "codex channel: /v1/chat/completions endpoint not supported"
}

pub(super) fn url(endpoint: &Url) -> Url {
    let mut url = endpoint.clone();
    if let Some(base) = endpoint.path().strip_suffix("/chat/completions") {
        url.set_path(&format!("{base}/responses"));
    }
    url
}

pub(super) fn body(call: &Call, input: &ActionInput) -> Value {
    let part = match input.kind {
        Kind::Text => json!({"type":"input_text","text":input.value}),
        Kind::Image => json!({"type":"input_image","image_url":input.value}),
    };
    json!({
        "model":call.model, "instructions":call.prompt, "store":false, "stream":true,
        "input":[{"role":"user","content":[part]}]
    })
}

fn output(response: &Value) -> ModelResult<String> {
    if response.get("error").is_some_and(|v| !v.is_null())
        || response
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|s| s != "completed")
    {
        return Err(error("provider", "服务未能完成这次模型调用。"));
    }
    let messages = response["output"].as_array().ok_or_else(format_error)?;
    let parts: Vec<_> = messages
        .iter()
        .filter(|m| m["type"] == "message")
        .filter_map(|m| m["content"].as_array())
        .flatten()
        .filter(|part| part["type"] == "output_text")
        .filter_map(|part| part["text"].as_str())
        .collect();
    Ok(parts.join(""))
}

pub(super) fn text(bytes: &[u8]) -> ModelResult<String> {
    let parsed = if let Ok(response) = serde_json::from_slice::<Value>(bytes) {
        output(&response)?
    } else {
        let stream = std::str::from_utf8(bytes)
            .map_err(|_| format_error())?
            .replace("\r\n", "\n");
        let mut deltas = String::new();
        let mut completed = None;
        for event in stream.split("\n\n") {
            let data = event
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(str::trim_start)
                .collect::<Vec<_>>()
                .join("\n");
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let frame: Value = serde_json::from_str(&data).map_err(|_| format_error())?;
            match frame["type"].as_str() {
                Some("response.output_text.delta") => {
                    deltas.push_str(frame["delta"].as_str().ok_or_else(format_error)?)
                }
                Some("response.completed") => completed = Some(output(&frame["response"])?),
                Some("error" | "response.failed" | "response.incomplete") => {
                    return Err(error("provider", "模型服务中断了此次输出，请重试。"))
                }
                _ => {}
            }
        }
        let final_text =
            completed.ok_or_else(|| error("response", "模型输出未完成，连接已结束。"))?;
        if final_text.is_empty() {
            deltas
        } else {
            final_text
        }
    };
    if parsed.trim().is_empty() {
        Err(error("response", "模型没有返回文字。"))
    } else {
        Ok(parsed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outputs_completed_text_once_for_json_and_events() {
        let response = json!({"status":"completed","output":[{"type":"reasoning"},{"type":"message","content":[{"type":"output_text","text":"你好"}]}]});
        assert_eq!(text(response.to_string().as_bytes()).unwrap(), "你好");
        let delta = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"你\"}\r\n\r\n";
        let final_event = json!({"type":"response.completed","response":response});
        assert_eq!(
            text(format!("{delta}data: {final_event}\r\n\r\n").as_bytes()).unwrap(),
            "你好"
        );
        assert!(text(delta.as_bytes()).is_err());
    }
}
