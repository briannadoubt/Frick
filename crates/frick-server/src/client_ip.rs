//! Trusted client-IP resolution for rate-limiting (FR-303).
//!
//! Behind a proxy/load balancer the socket peer is the proxy, and the real
//! client is in `X-Forwarded-For`. Trusting `X-Forwarded-For` unconditionally
//! lets any client spoof its IP (and defeat per-IP rate limits); trusting only
//! the socket peer breaks behind a proxy. The correct rule (matching the TS
//! server) is: trust the first `X-Forwarded-For` hop **only when the immediate
//! peer is a configured trusted proxy**, otherwise key by the raw socket
//! address.
//!
//! [`trusted_client_ip`] applies that rule; [`client_ip_from_headers`] exposes
//! the header-only fallback. A Rust backend's [`crate::boot::BootSeams::app_router`]
//! handlers extract the peer via `axum::extract::ConnectInfo<SocketAddr>` (the
//! framework serves with connect-info) and call [`trusted_client_ip`] with
//! [`crate::config::FrickConfig::trusted_proxies`].

use std::net::IpAddr;

use axum::http::HeaderMap;

/// An IP CIDR (e.g. `10.0.0.0/8`, `2001:db8::/32`, or a bare host address which
/// is a `/32` / `/128`). Parsed from `FRICK_TRUSTED_PROXIES` at boot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IpCidr {
    addr: IpAddr,
    prefix: u8,
}

impl IpCidr {
    /// Parse `"<addr>"` or `"<addr>/<prefix>"`. A bare address is a host route
    /// (`/32` for IPv4, `/128` for IPv6).
    pub fn parse(value: &str) -> Result<Self, String> {
        let value = value.trim();
        let (addr_str, prefix) = match value.split_once('/') {
            Some((addr, prefix)) => {
                let prefix: u8 = prefix
                    .trim()
                    .parse()
                    .map_err(|_| format!("invalid CIDR prefix in \"{value}\""))?;
                (addr.trim(), Some(prefix))
            }
            None => (value, None),
        };
        let addr: IpAddr = addr_str
            .parse()
            .map_err(|_| format!("invalid IP address in \"{value}\""))?;
        let max = if addr.is_ipv4() { 32 } else { 128 };
        let prefix = prefix.unwrap_or(max);
        if prefix > max {
            return Err(format!(
                "CIDR prefix /{prefix} exceeds /{max} in \"{value}\""
            ));
        }
        Ok(Self { addr, prefix })
    }

    /// `true` when `ip` falls within this CIDR (same family + matching prefix).
    #[must_use]
    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.addr, ip) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => {
                let mask = v4_mask(self.prefix);
                (u32::from(net) & mask) == (u32::from(ip) & mask)
            }
            (IpAddr::V6(net), IpAddr::V6(ip)) => {
                let mask = v6_mask(self.prefix);
                (u128::from(net) & mask) == (u128::from(ip) & mask)
            }
            _ => false,
        }
    }
}

fn v4_mask(prefix: u8) -> u32 {
    if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    }
}

fn v6_mask(prefix: u8) -> u128 {
    if prefix == 0 {
        0
    } else {
        u128::MAX << (128 - prefix)
    }
}

/// `true` when `peer` is inside any configured trusted-proxy CIDR.
#[must_use]
pub fn is_trusted_proxy(peer: IpAddr, trusted_proxies: &[IpCidr]) -> bool {
    trusted_proxies.iter().any(|cidr| cidr.contains(peer))
}

/// The client IP advertised in headers — the first `X-Forwarded-For` hop, then
/// `X-Real-IP`. `None` when neither is present/parseable. Header-only: this does
/// NOT validate the peer, so use it only when the deployment is known to be
/// behind a trusted proxy (or pair it with [`trusted_client_ip`]).
#[must_use]
pub fn client_ip_from_headers(headers: &HeaderMap) -> Option<IpAddr> {
    if let Some(forwarded) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok())
        && let Some(first) = forwarded.split(',').next()
        && let Ok(ip) = first.trim().parse::<IpAddr>()
    {
        return Some(ip);
    }
    headers
        .get("x-real-ip")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<IpAddr>().ok())
}

/// The rate-limit client IP: the first `X-Forwarded-For` hop **iff** the
/// immediate socket `peer` is a configured trusted proxy, otherwise `peer`
/// itself. This is the spoofing-resistant key a per-IP limiter should use.
#[must_use]
pub fn trusted_client_ip(headers: &HeaderMap, peer: IpAddr, trusted_proxies: &[IpCidr]) -> IpAddr {
    if is_trusted_proxy(peer, trusted_proxies)
        && let Some(forwarded) = client_ip_from_headers(headers)
    {
        return forwarded;
    }
    peer
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    fn headers_xff(value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", value.parse().unwrap());
        h
    }

    #[test]
    fn cidr_contains_matches_v4_and_v6_prefixes() {
        let v4 = IpCidr::parse("10.0.0.0/8").unwrap();
        assert!(v4.contains(ip("10.5.6.7")));
        assert!(!v4.contains(ip("11.0.0.1")));
        let host = IpCidr::parse("192.168.1.1").unwrap();
        assert!(host.contains(ip("192.168.1.1")));
        assert!(!host.contains(ip("192.168.1.2")));
        let v6 = IpCidr::parse("2001:db8::/32").unwrap();
        assert!(v6.contains(ip("2001:db8:1234::1")));
        assert!(!v6.contains(ip("2001:dead::1")));
    }

    #[test]
    fn cidr_parse_rejects_bad_input() {
        assert!(IpCidr::parse("nonsense").is_err());
        assert!(IpCidr::parse("10.0.0.0/33").is_err());
        assert!(IpCidr::parse("10.0.0.0/x").is_err());
    }

    #[test]
    fn trusts_forwarded_header_only_from_a_trusted_peer() {
        let trusted = vec![IpCidr::parse("10.0.0.0/8").unwrap()];
        let headers = headers_xff("203.0.113.9, 10.0.0.2");

        // Peer is the trusted proxy → trust the forwarded client.
        assert_eq!(
            trusted_client_ip(&headers, ip("10.0.0.2"), &trusted),
            ip("203.0.113.9")
        );
        // Peer is NOT trusted → ignore the header, key by the socket peer.
        assert_eq!(
            trusted_client_ip(&headers, ip("198.51.100.7"), &trusted),
            ip("198.51.100.7")
        );
        // No trusted proxies configured → always the peer.
        assert_eq!(
            trusted_client_ip(&headers, ip("10.0.0.2"), &[]),
            ip("10.0.0.2")
        );
    }
}
