use std::{ffi::OsString, io, path::Path};
use winreg::{
    enums::{HKEY_CURRENT_USER, KEY_SET_VALUE},
    RegKey,
};

pub const LOGIN_ARG: &str = "--autostart";
const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const APPROVAL: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
const NAME: &str = "FrogBoard";

fn command(exe: &Path) -> OsString {
    let mut value = OsString::from("\"");
    value.push(exe);
    value.push("\" ");
    value.push(LOGIN_ARG);
    value
}

fn optional<T>(result: io::Result<T>) -> io::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn enabled(root: &RegKey, exe: &Path) -> io::Result<bool> {
    let entry: Option<OsString> = optional(root.open_subkey(RUN).and_then(|k| k.get_value(NAME)))?;
    if entry != Some(command(exe)) {
        return Ok(false);
    }
    let approval = optional(
        root.open_subkey(APPROVAL)
            .and_then(|k| k.get_raw_value(NAME)),
    )?;
    Ok(!approval.is_some_and(|v| matches!(v.bytes.first(), Some(3 | 7))))
}

fn change(root: &RegKey, exe: &Path, enable: bool) -> io::Result<bool> {
    if enable {
        // Remove an old Task Manager override before explicitly enabling this copy.
        optional(
            root.open_subkey_with_flags(APPROVAL, KEY_SET_VALUE)
                .and_then(|k| k.delete_value(NAME)),
        )?;
        root.create_subkey(RUN)?.0.set_value(NAME, &command(exe))?;
    } else {
        optional(
            root.open_subkey_with_flags(RUN, KEY_SET_VALUE)
                .and_then(|k| k.delete_value(NAME)),
        )?;
    }
    enabled(root, exe)
}

#[tauri::command]
pub fn get_login_startup() -> Result<bool, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    enabled(&RegKey::predef(HKEY_CURRENT_USER), &exe)
        .map_err(|e| format!("无法读取 Windows 启动项：{e}"))
}

#[tauri::command]
pub fn set_login_startup(enable: bool) -> Result<bool, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    change(&RegKey::predef(HKEY_CURRENT_USER), &exe, enable)
        .map_err(|e| format!("无法更新 Windows 启动项：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use winreg::{enums::REG_BINARY, RegValue};

    #[test]
    fn registers_and_removes_only_the_test_entry() {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let path = format!(r"Software\FrogBoard-startup-test-{}", std::process::id());
        let root = hkcu.create_subkey(&path).unwrap().0;
        let exe = Path::new(r"C:\Program Files\青蛙跳板\frogboard.exe");
        assert!(!enabled(&root, exe).unwrap());
        assert!(change(&root, exe, true).unwrap());
        let value: String = root.open_subkey(RUN).unwrap().get_value(NAME).unwrap();
        assert_eq!(
            value,
            r#""C:\Program Files\青蛙跳板\frogboard.exe" --autostart"#
        );
        root.create_subkey(APPROVAL)
            .unwrap()
            .0
            .set_raw_value(
                NAME,
                &RegValue {
                    bytes: vec![3, 0, 0, 0].into(),
                    vtype: REG_BINARY,
                },
            )
            .unwrap();
        assert!(!enabled(&root, exe).unwrap());
        assert!(change(&root, exe, true).unwrap());
        assert!(!change(&root, exe, false).unwrap());
        assert!(!change(&root, exe, false).unwrap());
        drop(root);
        hkcu.delete_subkey_all(path).unwrap();
    }
}
