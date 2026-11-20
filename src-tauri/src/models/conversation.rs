use super::{error, validate_input, ActionInput, Call, Kind, ModelResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: Vec<ActionInput>,
}

impl Message {
    pub(super) fn single(input: ActionInput) -> Self {
        Self {
            role: Role::User,
            content: vec![input],
        }
    }

    fn text(&self) -> String {
        self.content
            .iter()
            .map(|p| p.value.as_str())
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    fn wire(&self, responses: bool) -> Value {
        let content = if self.role == Role::Assistant
            || (!responses && self.content.iter().all(|p| p.kind == Kind::Text))
        {
            json!(self.text())
        } else {
            Value::Array(
                self.content
                    .iter()
                    .map(|p| match (responses, p.kind) {
                        (true, Kind::Text) => json!({"type":"input_text","text":p.value}),
                        (true, Kind::Image) => json!({"type":"input_image","image_url":p.value}),
                        (false, Kind::Text) => json!({"type":"text","text":p.value}),
                        (false, Kind::Image) => {
                            json!({"type":"image_url","image_url":{"url":p.value}})
                        }
                    })
                    .collect(),
            )
        };
        json!({"role":self.role,"content":content})
    }
}

pub(super) fn validate(messages: &[Message]) -> ModelResult<Kind> {
    if messages.len().is_multiple_of(2) {
        return Err(error("input", "会话需要以用户提问结束。"));
    }
    let mut kind = Kind::Text;
    for (index, message) in messages.iter().enumerate() {
        if (message.role == Role::User) != (index % 2 == 0) || message.content.is_empty() {
            return Err(error("input", "会话消息顺序或内容无效。"));
        }
        for part in &message.content {
            if message.role == Role::Assistant {
                if part.kind != Kind::Text || part.value.trim().is_empty() {
                    return Err(error("input", "模型回复内容无效。"));
                }
            } else {
                validate_input(part)?;
            }
            if part.kind == Kind::Image {
                kind = Kind::Image;
            }
        }
    }
    Ok(kind)
}

pub(super) fn body(call: &Call, messages: &[Message], responses: bool) -> Value {
    let turns = messages.iter().map(|m| m.wire(responses));
    if responses {
        json!({"model":call.model,"instructions":call.prompt,"store":false,"stream":true,"input":turns.collect::<Vec<_>>()})
    } else {
        let system = json!({"role":"system","content":call.prompt});
        json!({"model":call.model,"stream":false,"messages":std::iter::once(system).chain(turns).collect::<Vec<_>>()})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_protocols_keep_image_context_and_role_order_on_followup() {
        let image = "data:image/png;base64,iVBORw0KGgo=";
        let turns: Vec<Message> = serde_json::from_value(json!([
            {"role":"user","content":[{"kind":"image","value":image},{"kind":"text","value":"读图"}]},
            {"role":"assistant","content":[{"kind":"text","value":"集合时间为九点。"}]},
            {"role":"user","content":[{"kind":"text","value":"改成下午"}]}
        ])).unwrap();
        assert!(validate(&turns).unwrap() == Kind::Image);
        assert!(validate(&turns[..2]).is_err());
        for responses in [false, true] {
            let call = Call {
                url: "http://localhost/v1".parse().unwrap(),
                model: "test".into(),
                key: None,
                auto_protocol: false,
                prompt: "回答问题".into(),
            };
            let request = body(&call, &turns, responses);
            let (array, offset) = if responses {
                (&request["input"], 0)
            } else {
                (&request["messages"], 1)
            };
            assert_eq!(array.as_array().unwrap().len(), offset + 3);
            assert_eq!(
                array[offset]["content"][0]["image_url"],
                if responses {
                    json!(image)
                } else {
                    json!({"url":image})
                }
            );
            assert_eq!(
                array[offset + 1],
                json!({"role":"assistant","content":"集合时间为九点。"})
            );
            assert_eq!(array[offset + 2]["role"], "user");
        }
    }
}
