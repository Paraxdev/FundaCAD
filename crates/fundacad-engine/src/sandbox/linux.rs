//! Linux: landlock limits writes to the engine's own folders at start, seccomp refuses new sockets once the live door
//! listens. Both are best effort by kernel: an older kernel enforces less, one without landlock limits no writes.

use std::io;
use std::path::PathBuf;

use landlock::{
    path_beneath_rules, Access, AccessFs, AccessNet, Ruleset, RulesetAttr, RulesetCreatedAttr, RulesetError,
    RulesetStatus, Scope, ABI,
};

use super::Outcome;

const ABI_WANTED: ABI = ABI::V6;

pub fn enter(writable: &[PathBuf]) -> Outcome {
    match restrict_writes(writable) {
        Ok(status) => Outcome::On { writes: status != RulesetStatus::NotEnforced },
        Err(e) => Outcome::Failed(format!("landlock refused the rules: {e}")),
    }
}

fn restrict_writes(writable: &[PathBuf]) -> Result<RulesetStatus, RulesetError> {
    let write = AccessFs::from_write(ABI_WANTED);
    let status = Ruleset::default()
        .handle_access(write)?
        // No port is allowed, so TCP connect fails on kernels with landlock ABI 4 or later. Bind stays open for the
        // live door.
        .handle_access(AccessNet::ConnectTcp)?
        .scope(Scope::from_all(ABI_WANTED))?
        .create()?
        .add_rules(path_beneath_rules(writable, write))?
        .add_rules(path_beneath_rules(["/dev/null"], write))?
        .restrict_self()?;
    Ok(status.ruleset)
}

#[cfg(target_arch = "x86_64")]
const AUDIT_ARCH: Option<u32> = Some(0xC000_003E);
#[cfg(target_arch = "aarch64")]
const AUDIT_ARCH: Option<u32> = Some(0xC000_00B7);
#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
const AUDIT_ARCH: Option<u32> = None;

// x32 system calls on x86_64 carry this bit and the native arch, so without the check they would get around the filter.
const X32_SYSCALL_BIT: u32 = 0x4000_0000;
const NR_OFFSET: u32 = 0;
const ARCH_OFFSET: u32 = 4;

fn op(code: u32, k: u32, jt: u8, jf: u8) -> libc::sock_filter {
    libc::sock_filter { code: code as u16, jt, jf, k }
}

/// socket() of any family and io_uring_setup() fail with EACCES in every thread. io_uring is closed too, since its
/// socket operation would get around the filter.
pub fn close_network() -> Result<(), String> {
    let Some(arch) = AUDIT_ARCH else {
        return Err("seccomp has no filter for this processor".into());
    };
    let load = libc::BPF_LD | libc::BPF_W | libc::BPF_ABS;
    let equal = libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K;
    let ret = libc::BPF_RET | libc::BPF_K;
    let deny = libc::SECCOMP_RET_ERRNO | libc::EACCES as u32;
    let mut filter = [
        op(load, ARCH_OFFSET, 0, 0),
        op(equal, arch, 0, 5),
        op(load, NR_OFFSET, 0, 0),
        op(libc::BPF_JMP | libc::BPF_JGE | libc::BPF_K, X32_SYSCALL_BIT, 3, 0),
        op(equal, libc::SYS_socket as u32, 2, 0),
        op(equal, libc::SYS_io_uring_setup as u32, 1, 0),
        op(ret, libc::SECCOMP_RET_ALLOW, 0, 0),
        op(ret, deny, 0, 0),
    ];
    let program = libc::sock_fprog { len: filter.len() as u16, filter: filter.as_mut_ptr() };
    // SAFETY: the kernel copies the program before the call returns, and it outlives the call.
    unsafe {
        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
            return Err(format!("no_new_privs failed: {}", io::Error::last_os_error()));
        }
        let rc = libc::syscall(
            libc::SYS_seccomp,
            libc::SECCOMP_SET_MODE_FILTER,
            libc::SECCOMP_FILTER_FLAG_TSYNC,
            &program as *const libc::sock_fprog,
        );
        match rc {
            0 => Ok(()),
            rc if rc > 0 => Err(format!("seccomp could not reach thread {rc}")),
            _ => Err(format!("seccomp refused the filter: {}", io::Error::last_os_error())),
        }
    }
}
