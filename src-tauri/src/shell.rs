use crate::{desktop, models};
use serde::{Deserialize, Serialize};
use std::{fs, sync::Mutex};
use tauri::{menu::MenuBuilder, tray::TrayIconBuilder, AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Preferences {
    clipboard: String,
    capture: String,
    translate: String,
    selection: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            clipboard: "Ctrl+Alt+V".into(),
            capture: "Ctrl+Alt+A".into(),
            translate: "Ctrl+Alt+T".into(),
            selection: true,
        }
    }
}

impl Preferences {
    fn bindings(&self) -> [(&'static str, &str); 3] {
        [
            ("clipboard", &self.clipboard),
            ("capture", &self.capture),
            ("translate", &self.translate),
        ]
    }
}

#[derive(Default)]
struct Shell {
    prefs: Mutex<Preferences>,
    warning: Mutex<String>,
}

#[tauri::command]
fn get_preferences(state: State<Shell>) -> (Preferences, String) {
    (
        state.prefs.lock().unwrap().clone(),
        state.warning.lock().unwrap().clone(),
    )
}

fn activate(app: &AppHandle, mode: &str) {
    if let Err(message) = desktop::start(app, mode) {
        let _ = app.emit("frog-error", message);
    }
}

fn register(app: &AppHandle, mode: &'static str, key: Shortcut) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(key, move |app, _, event| {
            if event.state == ShortcutState::Pressed {
                activate(app, mode);
            }
        })
        .map_err(|e| format!("无法注册快捷键 {key}，请检查是否已被占用。{e}"))
}

fn parse_bindings(prefs: &Preferences) -> Result<Vec<(&'static str, Shortcut)>, String> {
    let mut bindings = Vec::new();
    for (mode, value) in prefs.bindings() {
        let key: Shortcut = value
            .parse()
            .map_err(|_| format!("无法识别快捷键 {value}"))?;
        if key.mods.is_empty() || bindings.iter().any(|(_, existing)| existing == &key) {
            return Err("请为每个入口设置不同的组合键，并包含修饰键。".into());
        }
        bindings.push((mode, key));
    }
    Ok(bindings)
}

#[tauri::command]
fn save_preferences(
    app: AppHandle,
    preferences: Preferences,
    state: State<Shell>,
) -> Result<(), String> {
    let next = parse_bindings(&preferences)?;
    let mut current = state.prefs.lock().unwrap();
    let previous = parse_bindings(&current)?;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let temp = dir.join("shortcuts.tmp");
    fs::write(
        &temp,
        serde_json::to_vec_pretty(&preferences).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let old_active: Vec<_> = previous
        .into_iter()
        .filter(|(_, k)| app.global_shortcut().is_registered(*k))
        .collect();
    let change = || -> Result<(), String> {
        app.global_shortcut()
            .unregister_all()
            .map_err(|e| e.to_string())?;
        for (mode, key) in next {
            register(&app, mode, key)?;
        }
        fs::rename(&temp, dir.join("shortcuts.json")).map_err(|e| e.to_string())
    };
    if let Err(error) = change() {
        let _ = app.global_shortcut().unregister_all();
        let mut errors = vec![error];
        for (mode, key) in old_active {
            if let Err(message) = register(&app, mode, key) {
                errors.push(message);
            }
        }
        return Err(errors.join(" "));
    }
    desktop::enable_selection(preferences.selection);
    *current = preferences;
    state.warning.lock().unwrap().clear();
    Ok(())
}

#[tauri::command]
fn open_input(app: AppHandle, mode: String) -> Result<(), String> {
    match mode.as_str() {
        "clipboard" | "capture" | "translate" => desktop::start(&app, &mode),
        _ => Err("未知入口".into()),
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(Shell::default())
        .setup(|app| {
            let path = app.path().app_config_dir()?.join("shortcuts.json");
            let prefs = fs::read(path)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .filter(|p| parse_bindings(p).is_ok())
                .unwrap_or_default();
            let state = app.state::<Shell>();
            let mut warnings = Vec::new();
            for (mode, key) in parse_bindings(&prefs).expect("verified preferences") {
                if let Err(error) = register(app.handle(), mode, key) {
                    warnings.push(error);
                }
            }
            desktop::enable_selection(prefs.selection);
            *state.prefs.lock().unwrap() = prefs;
            *state.warning.lock().unwrap() = warnings.join(" ");
            desktop::init(app.handle());

            let menu = MenuBuilder::new(app)
                .text("clipboard", "剪贴板工作台")
                .text("capture", "截图与标注")
                .separator()
                .text("quit", "退出青蛙跳板")
                .build()?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("青蛙跳板 · FrogBoard")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "quit" => app.exit(0),
                    "clipboard" => activate(app, "clipboard"),
                    "capture" => activate(app, "capture"),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = desktop::hide_panel(window.app_handle().clone());
                let _ = window.emit("frog-dismiss", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_input,
            get_preferences,
            save_preferences,
            desktop::pending_input,
            desktop::clear_pending,
            desktop::finish_editor,
            desktop::hide_panel,
            desktop::copy_png,
            desktop::save_png,
            desktop::copy_text,
            models::model_settings_load,
            models::model_settings_save,
            models::model_action_run,
            models::model_action_cancel
        ])
        .run(tauri::generate_context!())
        .expect("FrogBoard failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcuts_are_unique_after_normalization() {
        let mut p = Preferences::default();
        assert_eq!(parse_bindings(&p).unwrap().len(), 3);
        p.capture = "Alt+Control+KeyV".into();
        assert!(parse_bindings(&p).is_err());
        p.capture = "KeyA".into();
        assert!(parse_bindings(&p).is_err());
    }
}
