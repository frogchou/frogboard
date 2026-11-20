use super::{capture, start_worker};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Once,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;
use windows::{
    core::w,
    Win32::{
        Foundation::*,
        Graphics::Gdi::*,
        System::{Com::*, LibraryLoader::GetModuleHandleW},
        UI::{Accessibility::*, HiDpi::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    },
};

static ENABLED: AtomicBool = AtomicBool::new(true);
static BADGE: AtomicUsize = AtomicUsize::new(0);
static START: Once = Once::new();
static EPOCH: AtomicUsize = AtomicUsize::new(0);
const DISMISS: u32 = WM_APP + 1;

pub(super) fn enable(enabled: bool) {
    ENABLED.store(enabled, Ordering::Release);
    if !enabled {
        dismiss();
    }
}
pub(super) fn dismiss() {
    EPOCH.fetch_add(1, Ordering::AcqRel);
    let hwnd = HWND(BADGE.load(Ordering::Acquire) as _);
    if !hwnd.is_invalid() {
        unsafe {
            SendMessageTimeoutW(
                hwnd,
                DISMISS,
                WPARAM(0),
                LPARAM(0),
                SMTO_ABORTIFHUNG,
                100,
                None,
            );
        }
    }
}

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

fn external(hwnd: HWND) -> bool {
    let mut pid = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    pid != 0 && pid != std::process::id()
}

// Some applications expose the text pattern only on the document surrounding
// a leaf. Stop at the application's process boundary, before reaching the desktop.
fn read_element(automation: &IUIAutomation2, mut element: IUIAutomationElement) -> Option<String> {
    unsafe {
        let pid = element.CurrentProcessId().ok()?;
        if pid as u32 == std::process::id() {
            return None;
        }
        let walker = automation.ControlViewWalker().ok()?;
        for _ in 0..12 {
            if element.CurrentProcessId().ok()? != pid
                || element.CurrentIsPassword().ok()?.as_bool()
            {
                return None;
            }
            if let Ok(pattern) =
                element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
            {
                if let Ok(ranges) = pattern.GetSelection() {
                    let mut pieces = Vec::new();
                    for index in 0..ranges.Length().ok()? {
                        let piece = ranges.GetElement(index).ok()?.GetText(-1).ok()?.to_string();
                        if !piece.trim().is_empty() {
                            pieces.push(piece);
                        }
                    }
                    if !pieces.is_empty() {
                        return Some(pieces.join("\n"));
                    }
                }
            }
            element = walker.GetParentElement(&element).ok()?;
        }
        None
    }
}

// Called only on windowless worker threads. UIA providers communicate with the
// source application's UI; a stalled provider must never stall our message loop.
pub(super) fn selected(point: POINT, prefer_focus: bool) -> Option<String> {
    unsafe {
        let foreground = GetForegroundWindow();
        if !external(foreground) {
            return None;
        }
        CoInitializeEx(None, COINIT_MULTITHREADED).ok().ok()?;
        let _apartment = Apartment;
        let automation: IUIAutomation2 =
            CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER).ok()?;
        let _ = automation.SetConnectionTimeout(350);
        let _ = automation.SetTransactionTimeout(500);
        let focused = automation.GetFocusedElement().ok();
        if focused
            .as_ref()
            .is_some_and(|el| el.CurrentIsPassword().is_ok_and(|b| b.as_bool()))
        {
            return None;
        }
        if prefer_focus {
            if let Some(text) = focused.clone().and_then(|el| read_element(&automation, el)) {
                return Some(text);
            }
        }
        if GetAncestor(WindowFromPoint(point), GA_ROOT) == GetAncestor(foreground, GA_ROOT) {
            if let Ok(element) = automation.ElementFromPoint(point) {
                if let Some(text) = read_element(&automation, element) {
                    return Some(text);
                }
            }
            if !prefer_focus {
                return focused.and_then(|el| read_element(&automation, el));
            }
        }
        None
    }
}

pub(super) fn init(app: AppHandle) {
    START.call_once(|| {
        let _ = thread::Builder::new()
            .name("frog-selection-badge".into())
            .spawn(|| badge_loop(app));
    });
}

unsafe extern "system" fn badge_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    unsafe {
        match msg {
            WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
            DISMISS => {
                let _ = ShowWindow(hwnd, SW_HIDE);
                LRESULT(0)
            }
            WM_PAINT => {
                let mut ps = PAINTSTRUCT::default();
                let dc = BeginPaint(hwnd, &mut ps);
                let mut rect = RECT::default();
                let _ = GetClientRect(hwnd, &mut rect);
                let brush = CreateSolidBrush(COLORREF(0x00473627));
                FillRect(dc, &rect, brush);
                let _ = DeleteObject(brush.into());
                let font = CreateFontW(
                    -(rect.bottom * 55 / 100),
                    0,
                    0,
                    0,
                    600,
                    0,
                    0,
                    0,
                    DEFAULT_CHARSET,
                    OUT_DEFAULT_PRECIS,
                    CLIP_DEFAULT_PRECIS,
                    CLEARTYPE_QUALITY,
                    0,
                    w!("Microsoft YaHei UI"),
                );
                let old = SelectObject(dc, font.into());
                SetBkMode(dc, TRANSPARENT);
                SetTextColor(dc, COLORREF(0x00bbefd6));
                DrawTextW(
                    dc,
                    &mut ['译' as u16],
                    &mut rect,
                    DT_SINGLELINE | DT_CENTER | DT_VCENTER,
                );
                SelectObject(dc, old);
                let _ = DeleteObject(font.into());
                let _ = EndPaint(hwnd, &ps);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wp, lp),
        }
    }
}

fn create_badge() -> windows::core::Result<HWND> {
    unsafe {
        let module = GetModuleHandleW(None)?;
        let class = w!("FrogBoard.Selection.v1");
        let wc = WNDCLASSW {
            hInstance: module.into(),
            lpfnWndProc: Some(badge_proc),
            lpszClassName: class,
            hCursor: LoadCursorW(None, IDC_HAND)?,
            ..Default::default()
        };
        RegisterClassW(&wc);
        CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
            class,
            w!("划词翻译"),
            WS_POPUP,
            0,
            0,
            32,
            32,
            None,
            None,
            Some(module.into()),
            None,
        )
    }
}

fn show_badge(hwnd: HWND, at: POINT) {
    let Ok(info) = capture::monitor(at) else {
        return;
    };
    let work = info.rcWork;
    unsafe {
        let (mut dpi_x, mut dpi_y) = (96, 96);
        let _ = GetDpiForMonitor(
            MonitorFromPoint(at, MONITOR_DEFAULTTONEAREST),
            MDT_EFFECTIVE_DPI,
            &mut dpi_x,
            &mut dpi_y,
        );
        let size = (32 * dpi_x as i32 / 96).clamp(24, 128);
        let gap = size / 3;
        let x = (at.x + gap).clamp(work.left, (work.right - size).max(work.left));
        let y = if at.y + gap + size < work.bottom {
            at.y + gap
        } else {
            (at.y - gap - size).max(work.top)
        };
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            x,
            y,
            size,
            size,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
}

#[derive(Clone, Copy)]
struct Probe {
    point: POINT,
    foreground: usize,
    epoch: usize,
}

fn badge_loop(app: AppHandle) {
    unsafe {
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let Ok(hwnd) = create_badge() else { return };
    BADGE.store(hwnd.0 as usize, Ordering::Release);
    let (probes, queue) = mpsc::sync_channel::<Probe>(1);
    let (answers, ready) = mpsc::channel();
    thread::spawn(move || {
        while let Ok(probe) = queue.recv() {
            if probe.epoch != EPOCH.load(Ordering::Acquire) {
                continue;
            }
            if let Some(text) = selected(probe.point, false) {
                if answers.send((probe, text)).is_err() {
                    break;
                }
            }
        }
    });
    let mut selection: Option<(Probe, String, Instant)> = None;
    let mut press = None;
    let mut last_release: Option<(POINT, Instant)> = None;
    let mut was_down = false;
    let mut timer_enabled = ENABLED.load(Ordering::Acquire);
    unsafe {
        SetTimer(Some(hwnd), 1, if timer_enabled { 30 } else { 500 }, None);
    }
    let mut msg = MSG::default();
    while unsafe { GetMessageW(&mut msg, None, 0, 0) }.0 > 0 {
        if msg.message == WM_LBUTTONUP && msg.hwnd == hwnd {
            unsafe {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
            if let Some((probe, text, until)) = selection.take() {
                if Instant::now() < until
                    && probe.foreground == unsafe { GetForegroundWindow() }.0 as usize
                    && probe.epoch == EPOCH.load(Ordering::Acquire)
                    && ENABLED.load(Ordering::Acquire)
                {
                    let _ = start_worker(&app, "selection", Some(text));
                }
            }
        } else if msg.message == WM_TIMER {
            let enabled = ENABLED.load(Ordering::Acquire);
            if enabled != timer_enabled {
                timer_enabled = enabled;
                unsafe {
                    SetTimer(Some(hwnd), 1, if enabled { 30 } else { 500 }, None);
                }
                press = None;
                last_release = None;
                was_down = false;
            }
            if !enabled {
                selection = None;
                continue;
            }
            let foreground = unsafe { GetForegroundWindow() };
            let now = Instant::now();
            if selection.as_ref().is_some_and(|(probe, _, until)| {
                now >= *until
                    || probe.foreground != foreground.0 as usize
                    || probe.epoch != EPOCH.load(Ordering::Acquire)
            }) {
                selection = None;
                unsafe {
                    let _ = ShowWindow(hwnd, SW_HIDE);
                }
            }
            let button = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0 {
                VK_RBUTTON
            } else {
                VK_LBUTTON
            };
            let down = unsafe { GetAsyncKeyState(i32::from(button.0)) } < 0;
            if down != was_down {
                was_down = down;
                let Ok(point) = capture::cursor() else {
                    continue;
                };
                let target = unsafe { WindowFromPoint(point) };
                if target == hwnd {
                    press = None;
                    continue;
                }
                if down {
                    EPOCH.fetch_add(1, Ordering::AcqRel);
                    selection = None;
                    unsafe {
                        let _ = ShowWindow(hwnd, SW_HIDE);
                    }
                    press = external(target).then_some(point);
                } else if let Some(start) = press.take() {
                    let dragged = (point.x - start.x).abs().max((point.y - start.y).abs()) >= 3;
                    let double = last_release.is_some_and(|(p, when)| {
                        now.duration_since(when).as_millis()
                            <= u128::from(unsafe { GetDoubleClickTime() })
                            && (point.x - p.x).abs().max((point.y - p.y).abs()) <= 4
                    });
                    last_release = Some((point, now));
                    if (dragged || double) && external(target) && external(foreground) {
                        let _ = probes.try_send(Probe {
                            point,
                            foreground: foreground.0 as usize,
                            epoch: EPOCH.load(Ordering::Acquire),
                        });
                    }
                }
            }
            while let Ok((probe, text)) = ready.try_recv() {
                if !down
                    && probe.epoch == EPOCH.load(Ordering::Acquire)
                    && probe.foreground == foreground.0 as usize
                {
                    show_badge(hwnd, probe.point);
                    selection = Some((probe, text, now + Duration::from_secs(8)));
                }
            }
        } else {
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
    BADGE.store(0, Ordering::Release);
}
