#!/bin/sh
# Sets up CLI alias and login banner
# Run inside the mbus2mqtt container

# Create symlink so 'mbus2mqtt' works as command
ln -sf /opt/mbus2mqtt/dist/index.js /usr/local/bin/mbus2mqtt
chmod +x /opt/mbus2mqtt/dist/index.js

# Shell alias with default config
cat > /etc/profile.d/mbus2mqtt.sh << 'EOF'
alias mbus2mqtt='node /opt/mbus2mqtt/dist/index.js -c /etc/mbus2mqtt/config.yaml'
EOF

# Login banner with available commands
cat > /etc/motd << 'EOF'
  ┌─────────────────────────────────────────────┐
  │  mbus2mqtt - M-Bus to MQTT Gateway          │
  ├─────────────────────────────────────────────┤
  │                                             │
  │  mbus2mqtt scan      Scan ports for meters  │
  │  mbus2mqtt list      Show meters & values   │
  │  mbus2mqtt read <id> Read single meter      │
  │  mbus2mqtt run       Start daemon           │
  │                                             │
  │  rc-service mbus2mqtt start|stop|status     │
  │  tail -f /var/log/mbus2mqtt.log             │
  │  vi /etc/mbus2mqtt/config.yaml              │
  │                                             │
  └─────────────────────────────────────────────┘
EOF
