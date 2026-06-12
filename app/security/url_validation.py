import socket
from ipaddress import ip_address
from urllib.parse import urlparse

_BLOCKED_HOSTNAMES = {"localhost"}
_BLOCKED_IPS = {ip_address("169.254.169.254")}


def validate_public_http_url(value: str | None) -> str | None:
    if value is None:
        return None

    url = value.strip()
    if not url:
        return None

    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ValueError("仅支持 https URL")
    if not parsed.hostname:
        raise ValueError("URL 缺少主机名")

    hostname = parsed.hostname.rstrip(".").lower()
    if hostname in _BLOCKED_HOSTNAMES:
        raise ValueError("不允许使用本机地址")

    if _looks_like_nonstandard_numeric_ip(hostname):
        raise ValueError("不允许使用非标准 IP 地址格式")

    try:
        host_ip = ip_address(hostname)
    except ValueError:
        _validate_resolved_addresses(hostname)
        return url

    _validate_public_ip(host_ip)
    return url


def _looks_like_nonstandard_numeric_ip(hostname: str) -> bool:
    labels = hostname.split(".")
    return all(label.isdigit() or label.startswith("0x") for label in labels)


def _validate_resolved_addresses(hostname: str) -> None:
    try:
        records = socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise ValueError("URL 主机名无法解析")

    if not records:
        raise ValueError("URL 主机名无法解析")

    for record in records:
        sockaddr = record[4]
        _validate_public_ip(ip_address(sockaddr[0]))


def _validate_public_ip(host_ip) -> None:
    if host_ip in _BLOCKED_IPS or not host_ip.is_global:
        raise ValueError("不允许使用内网、本机或保留地址")
