use super::*;
use std::time::{Duration, Instant};
use windows::Win32::{
    Foundation::{LPARAM, WPARAM},
    UI::WindowsAndMessaging::{PostMessageW, SC_CLOSE, WM_SYSCOMMAND},
};

// Runs a real HWND and the production title-bar close handler in isolation.
// No single-instance plugin, global shortcuts, clipboard reads or model calls.
#[test]
#[ignore = "requires an interactive Windows desktop with WebView2"]
fn closing_translation_preserves_compact_geometry_until_reopened() {
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "com.frogchou.frogboard.window-test".into();
    let config = &mut context.config_mut().app.windows[0];
    config.title = "FrogBoard window regression test".into();
    config.url = tauri::WebviewUrl::External("about:blank".parse().unwrap());
    let (send, result) = std::sync::mpsc::channel();
    let app = tauri::Builder::default()
        .any_thread()
        .on_window_event(crate::shell::on_window_event)
        .build(context)
        .unwrap();
    app.run_return(move |app, event| {
        if matches!(event, tauri::RunEvent::Ready) {
            let app = app.clone();
            let send = send.clone();
            thread::spawn(move || {
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let window = main_window(&app).unwrap();
                    for maximized in [false, true] {
                        if maximized {
                            window.maximize().unwrap();
                        }
                        let original = window.inner_size().unwrap();
                        let position = window.outer_position().unwrap();
                        let id = next_request();
                        with_current_window(&window, id, compact).unwrap();
                        let small = window.inner_size().unwrap();
                        assert_ne!(original, small);
                        unsafe {
                            PostMessageW(
                                Some(native_owner(&window).unwrap()),
                                WM_SYSCOMMAND,
                                WPARAM(SC_CLOSE as usize),
                                LPARAM(0),
                            )
                            .unwrap();
                        }
                        let deadline = Instant::now() + Duration::from_secs(5);
                        while window.is_visible().unwrap() {
                            assert!(
                                Instant::now() < deadline,
                                "title-bar close did not hide the window"
                            );
                            thread::sleep(Duration::from_millis(10));
                        }
                        assert_eq!(
                            window.inner_size().unwrap(),
                            small,
                            "close resized the popup"
                        );
                        reopen(&app).unwrap();
                        assert!(window.is_visible().unwrap());
                        assert_eq!(window.is_maximized().unwrap(), maximized);
                        assert_eq!(window.inner_size().unwrap(), original);
                        assert_eq!(window.outer_position().unwrap(), position);
                    }
                }));
                send.send(outcome).unwrap();
                app.exit(0);
            });
        }
    });
    if let Err(panic) = result.try_recv().unwrap() {
        std::panic::resume_unwind(panic);
    }
}
