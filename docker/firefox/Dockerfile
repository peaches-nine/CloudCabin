# Firefox —— 浏览器实例镜像
# 基于 KasmVNC 基础镜像（多架构 amd64/arm64）：Xvfb + openbox + KasmVNC
FROM lscr.io/linuxserver/baseimage-kasmvnc:debianbookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    # 切换 APT 源到阿里云镜像（加速国内构建）
    sed -i 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g' /etc/apt/sources.list /etc/apt/sources.list.d/*.list 2>/dev/null; \
    sed -i 's|http://security.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' /etc/apt/sources.list /etc/apt/sources.list.d/*.list 2>/dev/null; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        firefox-esr \
        fonts-wqy-zenhei fonts-wqy-microhei; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# openbox 会话启动时执行：以 kiosk 模式打开 Firefox
COPY autostart /defaults/autostart
RUN chmod +x /defaults/autostart

EXPOSE 3000 3001
