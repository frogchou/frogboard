mod capture;
mod clipboard;
mod selection;
#[cfg(test)]
mod window_tests;

use serde::Serialize;
use std::{
    fmt::Display,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex,
    },
    thread,
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use windows::Win32::{
    Foundation::HWND,
    Graphics::Dwm::DwmFlush,
    UI::HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2},
};

#[derive(Clone, Serialize)]
pub struct WindowBounds {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrogInput {
    id: u32,
    kind: &'static str,
    mode: &'static str,
    value: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    window_bounds: Vec<WindowBounds>,
}

static CURRENT: AtomicU32 = AtomicU32::new(0);
static PENDING: Mutex<Option<Arc<FrogInput>>> = Mutex::new(None);
static CAPTURE: Mutex<()> = Mutex::new(());
// Preserve the user's normal working size and location while a translation
// result is shown near the pointer, including a previously maximized panel.
struct Layout {
    position: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
    maximized: bool,
}
static BEFORE_COMPACT: Mutex<Option<Layout>> = Mutex::new(None);

fn err(e: impl Display) -> String {
    e.to_string()
}
fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".into())
}
fn native_owner(window: &WebviewWindow) -> Result<HWND, String> {
    window.hwnd().map(|hwnd| HWND(hwnd.0)).map_err(err)
}
fn next_request() -> u32 {
    let mut slot = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    let id = CURRENT.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
    *slot = None;
    id
}
fn current(id: u32) -> bool {
    CURRENT.load(Ordering::SeqCst) == id
}

// Geometry changes run as one operation on the window's thread. A dismissed
// or replaced worker can finish encoding its frame without reopening the UI.
fn with_current_window(
    window: &WebviewWindow,
    id: u32,
    change: impl FnOnce(&WebviewWindow) -> Result<(), String> + Send + 'static,
) -> Result<bool, String> {
    let target = window.clone();
    let (done, result) = std::sync::mpsc::channel();
    window
        .run_on_main_thread(move || {
            let changed = if current(id) {
                change(&target).map(|_| true)
            } else {
                Ok(false)
            };
            let _ = done.send(changed);
        })
        .map_err(err)?;
    result.recv().map_err(err)?
}

#[tauri::command]
pub fn pending_input() -> Option<FrogInput> {
    let pending = PENDING.lock().unwrap_or_else(|e| e.into_inner()).clone();
    pending.as_deref().cloned()
}
#[tauri::command]
pub fn clear_pending(id: u32) {
    let mut slot = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    if slot.as_ref().is_some_and(|event| event.id == id) {
        *slot = None;
    }
}

fn publish(window: &WebviewWindow, input: FrogInput) -> Result<(), String> {
    let input = Arc::new(input);
    {
        let mut slot = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        if !current(input.id) {
            return Ok(());
        }
        *slot = Some(input.clone());
    }
    window.emit("frog-input", input.as_ref()).map_err(err)
}

fn leave_fullscreen(window: &WebviewWindow) -> Result<(), String> {
    if window.is_fullscreen().map_err(err)? {
        window.set_fullscreen(false).map_err(err)?;
    }
    window.set_always_on_top(false).map_err(err)
}

fn restore(window: &WebviewWindow) -> Result<(), String> {
    leave_fullscreen(window)?;
    let layout = BEFORE_COMPACT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(layout) = layout {
        window.set_position(layout.position).map_err(err)?;
        window.set_size(layout.size).map_err(err)?;
        if layout.maximized {
            window.maximize().map_err(err)?;
        }
    }
    Ok(())
}

fn compact(window: &WebviewWindow) -> Result<(), String> {
    leave_fullscreen(window)?;
    let need_layout = BEFORE_COMPACT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_none();
    if need_layout {
        let maximized = window.is_maximized().map_err(err)?;
        if maximized {
            window.unmaximize().map_err(err)?;
        }
        let layout = Layout {
            position: window.outer_position().map_err(err)?,
            size: window.inner_size().map_err(err)?,
            maximized,
        };
        *BEFORE_COMPACT.lock().unwrap_or_else(|e| e.into_inner()) = Some(layout);
    }
    let cursor = capture::cursor()?;
    let work = capture::monitor(cursor)?.rcWork;
    // Cross the DPI boundary before requesting a logical size. The outer size
    // then includes the real non-client border at the destination monitor's DPI.
    window
        .set_position(tauri::PhysicalPosition::new(work.left, work.top))
        .map_err(err)?;
    window
        .set_size(tauri::LogicalSize::new(540.0, 390.0))
        .map_err(err)?;
    let size = window.outer_size().map_err(err)?;
    let x = (cursor.x + 14).clamp(work.left, (work.right - size.width as i32).max(work.left));
    let y = (cursor.y + 14).clamp(work.top, (work.bottom - size.height as i32).max(work.top));
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(err)
}
fn reveal(window: &WebviewWindow) -> Result<(), String> {
    window.unminimize().map_err(err)?;
    window.show().map_err(err)?;
    window.set_focus().map_err(err)
}
pub fn reopen(app: &AppHandle) -> Result<(), String> {
    let window = main_window(app)?;
    if !window.is_visible().map_err(err)? {
        restore(&window)?;
    }
    reveal(&window)
}
#[tauri::command]
pub fn hide_panel(app: AppHandle) -> Result<(), String> {
    let id = next_request();
    let window = main_window(&app)?;
    // Restoring a maximized workbench can show its HWND. Leave the layout
    // alone until an entry point actually needs the workbench again.
    window.hide().map_err(err)?;
    window.emit("frog-dismiss", id).map_err(err)
}
#[tauri::command]
pub fn finish_editor(app: AppHandle, id: u32, hide: bool) -> Result<bool, String> {
    if !current(id) {
        return Ok(false);
    }
    let window = main_window(&app)?;
    if hide {
        window.hide().map_err(err)?;
    } else {
        restore(&window)?;
        reveal(&window)?;
    }
    Ok(true)
}
pub fn enable_selection(enabled: bool) {
    selection::enable(enabled);
}
pub fn init(app: &AppHandle) {
    selection::init(app.clone());
}

pub fn start(app: &AppHandle, mode: &str) -> Result<(), String> {
    let mode = match mode {
        "clipboard" => "clipboard",
        "capture" => "capture",
        "translate" => "translate",
        _ => return Err("未知桌面操作".into()),
    };
    start_worker(app, mode, None)
}

pub fn refresh_clipboard(app: &AppHandle) -> Result<(), String> {
    start_worker(app, "refresh", None)
}

fn start_worker(app: &AppHandle, mode: &'static str, text: Option<String>) -> Result<(), String> {
    let window = main_window(app)?;
    let id = next_request();
    thread::Builder::new()
        .name("frog-desktop".into())
        .spawn(move || {
            unsafe {
                SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            }
            if !current(id) {
                return;
            }
            if let Err(error) = run(&window, id, mode, text) {
                let _ = with_current_window(&window, id, move |target| {
                    if mode != "refresh" {
                        restore(target)?;
                        reveal(target)?;
                    }
                    target.emit("frog-input-error", (id, error)).map_err(err)
                });
            }
        })
        .map_err(err)?;
    Ok(())
}

fn run(
    window: &WebviewWindow,
    id: u32,
    mode: &'static str,
    text: Option<String>,
) -> Result<(), String> {
    use clipboard::Content;
    selection::dismiss();
    let mut bounds = Vec::new();
    let mut fullscreen = None;
    let content = match mode {
        "selection" => Content::Text(text.ok_or("选区为空")?),
        "clipboard" | "refresh" => clipboard::read(native_owner(window)?)?,
        _ => {
            let point = capture::cursor()?;
            let selected = if mode == "translate" {
                selection::selected(point, true)
            } else {
                None
            };
            if let Some(text) = selected {
                Content::Text(text)
            } else {
                let _guard = CAPTURE.lock().unwrap_or_else(|e| e.into_inner());
                if !with_current_window(window, id, |target| target.hide().map_err(err))? {
                    return Ok(());
                }
                // The main thread has hidden the window. Wait until DWM has
                // composited its removal before sampling the desktop.
                unsafe {
                    let _ = DwmFlush();
                }
                let rect = capture::monitor(point)?.rcMonitor;
                let pixels = capture::freeze(rect)?;
                bounds = capture::windows_in(rect);
                fullscreen = Some(tauri::PhysicalPosition::new(
                    f64::from(point.x),
                    f64::from(point.y),
                ));
                Content::Png(pixels.into_png()?)
            }
        }
    };
    let (kind, value) = match content {
        Content::Text(s) => ("text", s),
        Content::Png(bytes) => ("image", clipboard::data_url(&bytes)),
        Content::Empty => ("empty", String::new()),
    };
    if !current(id) {
        return Ok(());
    }
    if mode == "refresh" {
        // The workbench is already visible. Only replace its input snapshot.
        return publish(
            window,
            FrogInput {
                id,
                kind,
                mode: "clipboard",
                value,
                window_bounds: bounds,
            },
        );
    }
    if !with_current_window(window, id, move |target| {
        if let Some(point) = fullscreen {
            target.set_fullscreen_on_monitor(point).map_err(err)?;
            target.set_always_on_top(true).map_err(err)
        } else if kind == "text" && matches!(mode, "translate" | "selection") {
            compact(target)
        } else {
            restore(target)
        }
    })? {
        return Ok(());
    }
    publish(
        window,
        FrogInput {
            id,
            kind,
            mode,
            value,
            window_bounds: bounds,
        },
    )?;
    with_current_window(window, id, reveal)?;
    Ok(())
}

#[tauri::command]
pub async fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    let window = main_window(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        clipboard::write_text(native_owner(&window)?, &text)
    })
    .await
    .map_err(err)?
}
#[tauri::command]
pub async fn copy_png(app: AppHandle, png: String) -> Result<(), String> {
    let window = main_window(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        clipboard::write_png(native_owner(&window)?, &clipboard::from_data_url(&png)?)
    })
    .await
    .map_err(err)?
}
#[tauri::command]
pub async fn save_png(app: AppHandle, png: String) -> Result<(), String> {
    let window = main_window(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = clipboard::from_data_url(&png)?;
        let file = rfd::FileDialog::new()
            .set_title("保存截图")
            .set_parent(&window)
            .add_filter("PNG 图像", &["png"])
            .set_file_name("FrogBoard.png")
            .save_file();
        if let Some(path) = file {
            std::fs::write(path, bytes).map_err(err)?;
        }
        Ok(())
    })
    .await
    .map_err(err)?
}
