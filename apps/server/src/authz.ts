export interface Principal {
  userId: string;
  deviceId: string;
  replicaId: string;
}

export function principalFromHello(replicaId: string, deviceId: string): Principal {
  return {
    userId: replicaId.includes("grace") ? "user-grace" : "user-ada",
    deviceId,
    replicaId,
  };
}

export function assertCanSubscribe(
  _principal: Principal,
  _kind: string,
  _name: string,
  _key?: string,
): void {}

export function assertCanAppend(_principal: Principal, _stream: string, _key: string): void {}

export function assertCanSignal(_principal: Principal, _signal: string, _key: string): void {}
