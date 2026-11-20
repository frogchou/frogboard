use super::{capture, err};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{io::Cursor, ptr, thread, time::Duration};
use windows::{
    core::w,
    Win32::{
        Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND},
        Graphics::Gdi::HBITMAP,
        System::{
            DataExchange::*,
            Memory::*,
            Ole::{CF_BITMAP, CF_DIB, CF_UNICODETEXT},
        },
    },
};

const LIMIT: usize = 256 * 1024 * 1024;
const PNG_PREFIX: &str = "data:image/png;base64,";
const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

pub(super) enum Content {
    Text(String),
    Png(Vec<u8>),
    Empty,
}

pub(super) fn data_url(bytes: &[u8]) -> String {
    let mut data = String::with_capacity(PNG_PREFIX.len() + bytes.len().div_ceil(3) * 4);
    data.push_str(PNG_PREFIX);
    STANDARD.encode_string(bytes, &mut data);
    data
}

pub(super) fn from_data_url(value: &str) -> Result<Vec<u8>, String> {
    let payload = value.strip_prefix(PNG_PREFIX).unwrap_or(value);
    if payload.len() > LIMIT * 4 / 3 {
        return Err("PNG 文件过大".into());
    }
    let bytes = STANDARD.decode(payload).map_err(err)?;
    if !bytes.starts_with(PNG_MAGIC) {
        return Err("无效的 PNG 图片".into());
    }
    Ok(bytes)
}

struct Open;
impl Open {
    fn new(owner: HWND) -> Result<Self, String> {
        for _ in 0..8 {
            if unsafe { OpenClipboard(Some(owner)) }.is_ok() {
                return Ok(Open);
            }
            thread::sleep(Duration::from_millis(12));
        }
        Err("剪贴板正被其他应用占用，请重试".into())
    }
}
impl Drop for Open {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}

// A successful SetClipboardData transfers this allocation to Windows.
struct Block(HGLOBAL);
impl Block {
    fn new(bytes: &[u8]) -> Result<Self, String> {
        let block =
            Self(unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len()) }.map_err(err)?);
        unsafe {
            let mem = GlobalLock(block.0);
            if mem.is_null() {
                return Err("无法分配剪贴板内存".into());
            }
            ptr::copy_nonoverlapping(bytes.as_ptr(), mem.cast(), bytes.len());
            let _ = GlobalUnlock(block.0);
        }
        Ok(block)
    }
    fn publish(self, format: u32) -> Result<(), String> {
        unsafe { SetClipboardData(format, Some(HANDLE(self.0 .0))) }.map_err(err)?;
        std::mem::forget(self);
        Ok(())
    }
}
impl Drop for Block {
    fn drop(&mut self) {
        unsafe {
            let _ = GlobalFree(Some(self.0));
        }
    }
}

fn read_block(format: u32) -> Result<Vec<u8>, String> {
    unsafe {
        let handle = HGLOBAL(GetClipboardData(format).map_err(err)?.0);
        let len = GlobalSize(handle);
        if len == 0 || len > LIMIT {
            return Err("剪贴板内容大小无效".into());
        }
        let mem = GlobalLock(handle).cast::<u8>();
        if mem.is_null() {
            return Err("无法锁定剪贴板内容".into());
        }
        let data = std::slice::from_raw_parts(mem, len).to_vec();
        let _ = GlobalUnlock(handle);
        Ok(data)
    }
}

fn png_format() -> u32 {
    unsafe { RegisterClipboardFormatW(w!("PNG")) }
}
fn available(format: u32) -> bool {
    format != 0 && unsafe { IsClipboardFormatAvailable(format) }.is_ok()
}

pub(super) fn read(owner: HWND) -> Result<Content, String> {
    let lock = Open::new(owner)?;
    let png = png_format();
    if available(png) {
        if let Ok(data) = read_block(png) {
            if data.starts_with(PNG_MAGIC) {
                return Ok(Content::Png(data));
            }
        }
    }
    if available(u32::from(CF_BITMAP.0)) {
        let handle = unsafe { GetClipboardData(CF_BITMAP.0.into()) }.map_err(err)?;
        let pixels = capture::bitmap_pixels(HBITMAP(handle.0))?;
        drop(lock);
        return pixels.into_png().map(Content::Png);
    }
    if available(CF_UNICODETEXT.0.into()) {
        let bytes = read_block(CF_UNICODETEXT.0.into())?;
        let units: Vec<_> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .copied()
            .map(u16::from_le_bytes)
            .take_while(|unit| *unit != 0)
            .collect();
        if !units.is_empty() {
            return Ok(Content::Text(String::from_utf16_lossy(&units)));
        }
    }
    Ok(Content::Empty)
}

pub(super) fn write_text(owner: HWND, text: &str) -> Result<(), String> {
    let bytes: Vec<u8> = text
        .encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(u16::to_le_bytes)
        .collect();
    let block = Block::new(&bytes)?;
    let _lock = Open::new(owner)?;
    unsafe { EmptyClipboard() }.map_err(err)?;
    block.publish(CF_UNICODETEXT.0.into())
}

// Offer both registered PNG (retains alpha) and a standard opaque CF_DIB so
// Paint, Office and apps that only understand Win32 bitmap formats can paste.
fn compatible_dib(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoder = png::Decoder::new(Cursor::new(data));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(err)?;
    let w = i32::try_from(reader.info().width).map_err(err)?;
    let h = i32::try_from(reader.info().height).map_err(err)?;
    let bytes = capture::pixel_bytes(w, h)?;
    let mut frame = vec![
        0;
        reader
            .output_buffer_size()
            .filter(|n| *n <= bytes)
            .ok_or("图片尺寸无效")?
    ];
    let info = reader.next_frame(&mut frame).map_err(err)?;
    let channels = info.color_type.samples();
    let mut dib = vec![0; 40 + bytes];
    dib[0..4].copy_from_slice(&40u32.to_le_bytes());
    dib[4..8].copy_from_slice(&w.to_le_bytes());
    dib[8..12].copy_from_slice(&(-h).to_le_bytes());
    dib[12..14].copy_from_slice(&1u16.to_le_bytes());
    dib[14..16].copy_from_slice(&32u16.to_le_bytes());
    dib[20..24].copy_from_slice(&(bytes as u32).to_le_bytes());
    for (source, dest) in frame[..info.buffer_size()]
        .chunks_exact(channels)
        .zip(dib[40..].as_chunks_mut::<4>().0)
    {
        let (r, g, b, a) = match source {
            [r, g, b, a] => (*r, *g, *b, *a),
            [r, g, b] => (*r, *g, *b, 255),
            [v, a] => (*v, *v, *v, *a),
            [v] => (*v, *v, *v, 255),
            _ => return Err("无效的 PNG 像素格式".into()),
        };
        let opaque =
            |v: u8| ((u32::from(v) * u32::from(a) + 255 * (255 - u32::from(a)) + 127) / 255) as u8;
        dest.copy_from_slice(&[opaque(b), opaque(g), opaque(r), 0]);
    }
    Ok(dib)
}

pub(super) fn write_png(owner: HWND, data: &[u8]) -> Result<(), String> {
    let dib = Block::new(&compatible_dib(data)?)?;
    let png = Block::new(data)?;
    let format = png_format();
    let _lock = Open::new(owner)?;
    unsafe { EmptyClipboard() }.map_err(err)?;
    dib.publish(CF_DIB.0.into())?;
    if format != 0 {
        png.publish(format)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screen_colors_and_row_order_survive_png_and_windows_bitmap_conversion() {
        let pixels = capture::Pixels {
            width: 1,
            height: 2,
            bgra: vec![0, 0, 255, 0, 255, 0, 0, 0],
        };
        let png = pixels.into_png().unwrap();
        let encoded = data_url(&png);
        assert_eq!(from_data_url(&encoded).unwrap(), png);
        let dib = compatible_dib(&png).unwrap();
        assert_eq!(&dib[8..12], &(-2i32).to_le_bytes());
        assert_eq!(&dib[40..], &[0, 0, 255, 0, 255, 0, 0, 0]);
    }

    #[test]
    fn transparent_canvas_pixels_render_white_for_standard_bitmap_consumers() {
        let mut png = Vec::new();
        let mut encoder = png::Encoder::new(&mut png, 2, 1);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer
            .write_image_data(&[80, 50, 20, 0, 255, 0, 0, 128])
            .unwrap();
        writer.finish().unwrap();
        assert_eq!(
            &compatible_dib(&png).unwrap()[40..],
            &[255, 255, 255, 0, 127, 127, 255, 0]
        );
    }
}
