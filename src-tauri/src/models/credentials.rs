use super::{error, ModelResult};

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{ptr, slice};
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND};
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    fn target(reference: &str) -> Vec<u16> {
        format!("FrogBoard/model/{reference}")
            .encode_utf16()
            .chain(Some(0))
            .collect()
    }

    pub fn read(reference: &str) -> ModelResult<String> {
        let target = target(reference);
        let mut credential = ptr::null_mut();
        // The returned credential and its blob share one allocation owned by CredFree.
        unsafe {
            if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) == 0 {
                return Err(error(
                    "credential",
                    "无法读取 API 密钥，请在模型设置中重新输入。",
                ));
            }
            let data = &*credential;
            let result = if data.CredentialBlobSize == 0 || data.CredentialBlob.is_null() {
                None
            } else {
                let bytes =
                    slice::from_raw_parts(data.CredentialBlob, data.CredentialBlobSize as usize);
                std::str::from_utf8(bytes).ok().map(str::to_owned)
            };
            CredFree(credential.cast());
            result.ok_or_else(|| error("credential", "密钥无效，请重新输入。"))
        }
    }

    pub fn write(reference: &str, key: &str) -> ModelResult<()> {
        let mut target = target(reference);
        let mut credential: CREDENTIALW = unsafe { std::mem::zeroed() };
        credential.Type = CRED_TYPE_GENERIC;
        credential.TargetName = target.as_mut_ptr();
        credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
        credential.CredentialBlobSize = key.len() as u32;
        credential.CredentialBlob = key.as_ptr() as *mut u8;
        if unsafe { CredWriteW(&credential, 0) } == 0 {
            return Err(error(
                "credential",
                "Windows 凭据管理器未能保存密钥，请重试。",
            ));
        }
        Ok(())
    }

    pub fn delete(reference: &str) -> ModelResult<()> {
        let target = target(reference);
        unsafe {
            if CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) == 0
                && GetLastError() != ERROR_NOT_FOUND
            {
                return Err(error(
                    "credential",
                    "无法清理 Windows 凭据管理器中的旧密钥。",
                ));
            }
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;
    pub fn read(_: &str) -> ModelResult<String> {
        Err(error("credential", "密钥存储需要 Windows 凭据管理器。"))
    }
    pub fn write(_: &str, _: &str) -> ModelResult<()> {
        Err(error("credential", "密钥存储需要 Windows 凭据管理器。"))
    }
    pub fn delete(_: &str) -> ModelResult<()> {
        Ok(())
    }
}

pub(super) use platform::{delete, read, write};
