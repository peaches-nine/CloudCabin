# Gaming —— KasmVNC + Mesa 25 + Steam + GPU 直通
FROM lscr.io/linuxserver/baseimage-kasmvnc:debianbookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    sed -i 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g' /etc/apt/sources.list /etc/apt/sources.list.d/*.list 2>/dev/null; \
    sed -i 's|http://security.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' /etc/apt/sources.list /etc/apt/sources.list.d/*.list 2>/dev/null; \
    echo 'deb http://mirrors.aliyun.com/debian bookworm non-free' >> /etc/apt/sources.list; \
    echo 'deb http://mirrors.aliyun.com/debian bookworm-backports main' >> /etc/apt/sources.list; \
    dpkg --add-architecture i386; \
    apt-get update

# 一次性装完所有依赖
RUN set -eux; \
    apt-get install -y --no-install-recommends \
        -t bookworm-backports \
        mesa-va-drivers mesa-vulkan-drivers libgl1-mesa-dri libglx-mesa0 \
        libgl1-mesa-dri:i386 libglx-mesa0:i386 mesa-vulkan-drivers:i386 \
        libdrm2:i386 libgl1:i386 libegl1:i386 libgbm1:i386 \
        libc6:i386 zlib1g:i386 libgcc-s1:i386 libstdc++6:i386; \
    curl -fsSL -o /tmp/steam.deb https://cdn.cloudflare.steamstatic.com/client/installer/steam.deb || \
    curl -fsSL -o /tmp/steam.deb https://cdn.fastly.steamstatic.com/client/installer/steam.deb; \
    apt-get install -y --no-install-recommends /tmp/steam.deb; \
    rm -f /tmp/steam.deb; \
    apt-get install -y --no-install-recommends \
        fonts-wqy-zenhei fonts-wqy-microhei mesa-utils xdotool; \
    mv /usr/bin/xterm /usr/bin/xterm.real 2>/dev/null || true; \
    ln -s /bin/true /usr/bin/xterm; \
    apt-get clean; rm -rf /var/lib/apt/lists/*

COPY fix-gpu-perms /custom-cont-init.d/01-gpu-perms
RUN chmod +x /custom-cont-init.d/01-gpu-perms

COPY autostart /defaults/autostart
RUN chmod +x /defaults/autostart

EXPOSE 3000 3001
