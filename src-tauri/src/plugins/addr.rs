//! Which addresses a plugin request may reach. Tauri free so scripts/check-plugin-guards.sh can run its tests on their
//! own.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Private, unique-local or link-local. Not loopback, not anything routable.
pub fn is_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_local(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

/// The IPv4 address an IPv6 one stands for: IPv4 mapped, IPv4 compatible, NAT64 (64:ff9b::/96) or 6to4 (2002::/16).
pub fn embedded_ipv4(v6: Ipv6Addr) -> Option<Ipv4Addr> {
    let s = v6.segments();
    let tail = |hi: u16, lo: u16| Some(Ipv4Addr::from(((hi as u32) << 16) | lo as u32));
    match s {
        [0, 0, 0, 0, 0, 0xffff, hi, lo] | [0, 0, 0, 0, 0, 0, hi, lo] | [0x64, 0xff9b, 0, 0, 0, 0, hi, lo] => {
            tail(hi, lo)
        }
        [0x2002, hi, lo, ..] => tail(hi, lo),
        _ => None,
    }
}

/// The inverse of the local rule, so the loopback engine port and the local network stay out of reach even for a name
/// that resolves there. An IPv6 form that carries an IPv4 address is judged by that address.
pub fn is_public(ip: IpAddr) -> bool {
    let v4 = match ip {
        IpAddr::V4(v4) => Some(v4),
        IpAddr::V6(v6) => embedded_ipv4(v6),
    };
    let special = match (ip, v4) {
        (_, Some(v4)) => {
            v4.is_loopback()
                || v4.is_unspecified()
                || v4.is_multicast()
                || v4.is_documentation()
                || v4.octets()[0] == 0
                || v4.octets()[0] >= 240
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64)
        }
        (IpAddr::V6(v6), None) => {
            let s = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s[0] & 0xffc0) == 0xfec0
                // 64:ff9b:1::/48 is local use NAT64, where the IPv4 part sits at a network chosen offset.
                || (s[0] == 0x64 && s[1] == 0xff9b && s[2] == 1)
        }
        _ => false,
    };
    !special && !is_local(v4.map(IpAddr::V4).unwrap_or(ip))
}
