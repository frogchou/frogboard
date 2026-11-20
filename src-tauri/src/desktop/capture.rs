use super::WindowBounds;
use std::mem::size_of;
use windows::core::BOOL;
use windows::Win32::{
    Foundation::{HWND, LPARAM, POINT, RECT},
    Graphics::{
        Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS},
        Gdi::*,
    },
    UI::WindowsAndMessaging::*,
};

// Each frame is top-down, in the monitor's physical pixels. Win32's 32-bit BI_RGB
// format stores B,G,R and a reserved byte. Never treat this byte as opacity.
pub(super) struct Pixels {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

pub(super) fn pixel_bytes(w: i32, h: i32) -> Result<usize, String> {
    if w <= 0 || h <= 0 || i64::from(w) * i64::from(h) > 64 * 1024 * 1024 {
        return Err("图片尺寸无效或超过处理上限".into());
    }
    Ok(w as usize * h as usize * 4)
}

impl Pixels {
    pub fn into_png(mut self) -> Result<Vec<u8>, String> {
        for px in self.bgra.as_chunks_mut::<4>().0 {
            px.swap(0, 2);
            px[3] = 255;
        }
        let mut bytes = Vec::new();
        let mut encoder = png::Encoder::new(&mut bytes, self.width, self.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(super::err)?;
        writer.write_image_data(&self.bgra).map_err(super::err)?;
        writer.finish().map_err(super::err)?;
        Ok(bytes)
    }
}

struct ScreenDc(HDC);
impl ScreenDc {
    fn new() -> Result<Self, String> {
        let dc = unsafe { GetDC(None) };
        if dc.is_invalid() {
            Err("无法读取桌面".into())
        } else {
            Ok(Self(dc))
        }
    }
}
impl Drop for ScreenDc {
    fn drop(&mut self) {
        unsafe {
            ReleaseDC(None, self.0);
        }
    }
}

pub(super) fn bitmap_pixels(bitmap: HBITMAP) -> Result<Pixels, String> {
    let mut desc = BITMAP::default();
    unsafe {
        if GetObjectW(
            bitmap.into(),
            size_of::<BITMAP>() as i32,
            Some((&raw mut desc).cast()),
        ) == 0
        {
            return Err("无法读取位图尺寸".into());
        }
        let (w, h) = (desc.bmWidth, desc.bmHeight);
        let mut bgra = vec![0; pixel_bytes(w, h)?];
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let screen = ScreenDc::new()?;
        if GetDIBits(
            screen.0,
            bitmap,
            0,
            h as u32,
            Some(bgra.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        ) != h
        {
            return Err("读取位图像素失败".into());
        }
        Ok(Pixels {
            width: w as u32,
            height: h as u32,
            bgra,
        })
    }
}

pub(super) fn cursor() -> Result<POINT, String> {
    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point) }.map_err(super::err)?;
    Ok(point)
}

pub(super) fn monitor(point: POINT) -> Result<MONITORINFO, String> {
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    unsafe { GetMonitorInfoW(MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST), &mut info) }
        .ok()
        .map_err(super::err)?;
    Ok(info)
}

pub(super) fn freeze(bounds: RECT) -> Result<Pixels, String> {
    let (w, h) = (bounds.right - bounds.left, bounds.bottom - bounds.top);
    pixel_bytes(w, h)?;
    let screen = ScreenDc::new()?;
    unsafe {
        let dc = CreateCompatibleDC(Some(screen.0));
        if dc.is_invalid() {
            return Err("无法创建截图画布".into());
        }
        let bitmap = CreateCompatibleBitmap(screen.0, w, h);
        if bitmap.is_invalid() {
            let _ = DeleteDC(dc);
            return Err("无法分配截图位图".into());
        }
        let old = SelectObject(dc, bitmap.into());
        let copied = BitBlt(
            dc,
            0,
            0,
            w,
            h,
            Some(screen.0),
            bounds.left,
            bounds.top,
            SRCCOPY | CAPTUREBLT,
        );
        SelectObject(dc, old);
        let _ = DeleteDC(dc);
        let result = copied
            .map_err(super::err)
            .and_then(|_| bitmap_pixels(bitmap));
        let _ = DeleteObject(bitmap.into());
        result
    }
}

struct WindowList {
    monitor: RECT,
    bounds: Vec<WindowBounds>,
}

// EnumWindows walks the desktop in z-order. The first containing rectangle is
// the visible window under that pixel, even when a larger window overlaps it.
unsafe extern "system" fn visit(hwnd: HWND, param: LPARAM) -> BOOL {
    unsafe {
        let list = &mut *(param.0 as *mut WindowList);
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return true.into();
        }
        let mut owner = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut owner));
        if owner == std::process::id() {
            return true.into();
        }
        let mut cloaked = 0u32;
        let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, (&raw mut cloaked).cast(), 4);
        if cloaked != 0 {
            return true.into();
        }
        let mut rect = RECT::default();
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&raw mut rect).cast(),
            size_of::<RECT>() as u32,
        )
        .is_err()
            && GetWindowRect(hwnd, &mut rect).is_err()
        {
            return true.into();
        }
        let area = list.monitor;
        let x = rect.left.max(area.left);
        let y = rect.top.max(area.top);
        let w = rect.right.min(area.right) - x;
        let h = rect.bottom.min(area.bottom) - y;
        if w >= 8 && h >= 8 {
            list.bounds.push(WindowBounds {
                x: x - area.left,
                y: y - area.top,
                w,
                h,
            });
        }
        true.into()
    }
}

pub(super) fn windows_in(rect: RECT) -> Vec<WindowBounds> {
    let mut list = WindowList {
        monitor: rect,
        bounds: Vec::new(),
    };
    unsafe {
        let _ = EnumWindows(Some(visit), LPARAM((&raw mut list) as isize));
    }
    list.bounds
}
