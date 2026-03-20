export function haStateTopic(property: string, deviceId: string): string {
  return `mbus2mqtt/${property}/${deviceId}/state`;
}

export function haDiscoveryTopic(property: string, deviceId: string): string {
  const uid = `mbus2mqtt_${property}_${deviceId}`.replace(/[^a-zA-Z0-9_]/g, '_');
  return `homeassistant/sensor/${uid}/config`;
}

export function houseAiTopic(property: string, deviceId: string): string {
  return `house-ai/${property}/meters/${deviceId}`;
}
