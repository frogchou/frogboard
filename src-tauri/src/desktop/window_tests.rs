use super::*;
use std::time::{Duration, Instant};
use windows::Win32::{
    Foundation::{LPARAM, WPARAM},
    UI::WindowsAndMessaging::{PostMessageW, SC_CLOSE, WM_LBUTTONDBLCLK, WM_SYSCOMMAND},
};

// Runs a real HWND and the production title-bar close handler in isolation.
// The tray path opens the clipboard workbench locally; no model is configured.
#[test]
#[ignore = "requires an interactive Windows desktop with WebView2"]
fn translation_shares_workbench_size_and_hides_in_place() {
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "com.frogchou.frogboard.window-test".into();
    let config = &mut context.config_mut().app.windows[0];
    config.title = "FrogBoard window regression test".into();
    config.visible = false;
    config.url = tauri::WebviewUrl::External("about:blank".parse().unwrap());
    let (send, result) = std::sync::mpsc::channel();
    let app = tauri::Builder::default()
        .any_thread()
        .setup(|app| Ok(crate::shell::install_tray(app)?))
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
                    assert!(!window.is_visible().unwrap());
                    let tray = app.tray_by_id("workbench").unwrap();
                    tray.with_inner_tray_icon(|icon| unsafe {
                        // Explorer's callback message for the pinned tray-icon version.
                        PostMessageW(
                            Some(HWND(icon.window_handle() as _)),
                            6002,
                            WPARAM(0),
                            LPARAM(WM_LBUTTONDBLCLK as isize),
                        )
                        .unwrap();
                    })
                    .unwrap();
                    let deadline = Instant::now() + Duration::from_secs(8);
                    while !window.is_visible().unwrap() {
                        assert!(
                            Instant::now() < deadline,
                            "tray double-click did not open workbench"
                        );
                        thread::sleep(Duration::from_millis(25));
                    }
                    for (custom_size, maximized) in [(false, false), (true, false), (false, true)] {
                        if custom_size {
                            window.set_size(tauri::LogicalSize::new(880, 620)).unwrap();
                        }
                        if maximized {
                            window.maximize().unwrap();
                        }
                        let logical_size = || {
                            window
                                .inner_size()
                                .unwrap()
                                .to_logical::<f64>(window.scale_factor().unwrap())
                        };
                        let original = logical_size();
                        let position = window.outer_position().unwrap();
                        let id = next_request();
                        with_current_window(&window, id, position_translation).unwrap();
                        assert_eq!(window.is_maximized().unwrap(), maximized);
                        assert!((logical_size().width - original.width).abs() <= 1.0);
                        assert!((logical_size().height - original.height).abs() <= 1.0);
                        if custom_size {
                            window.set_size(tauri::LogicalSize::new(840, 610)).unwrap();
                            with_current_window(&window, id, position_translation).unwrap();
                            assert!((logical_size().width - 840.0).abs() <= 1.0);
                            assert!((logical_size().height - 610.0).abs() <= 1.0);
                        }
                        let translated = logical_size();
                        let before_close = window.outer_position().unwrap();
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
                        assert_eq!(logical_size(), translated, "close resized the window");
                        assert_eq!(
                            window.outer_position().unwrap(),
                            before_close,
                            "close moved the window"
                        );
                        reopen(&app).unwrap();
                        assert!(window.is_visible().unwrap());
                        assert_eq!(window.is_maximized().unwrap(), maximized);
                        assert!((logical_size().width - translated.width).abs() <= 1.0);
                        assert!((logical_size().height - translated.height).abs() <= 1.0);
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
