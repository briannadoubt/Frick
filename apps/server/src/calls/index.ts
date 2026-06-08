// FR-78 — media-plane adapter boundary + deterministic fake.
export {
  MediaPlaneError,
  type AllocateSessionOptions,
  type IssueJoinTokenOptions,
  type MediaJoinGrant,
  type MediaParticipant,
  type MediaPlaneAdapter,
  type MediaPlaneCapabilities,
  type MediaPlaneTransport,
  type MediaSession,
} from "./media-plane.js";
export { FakeMediaPlaneAdapter, type FakeMediaPlaneOptions } from "./fake-media-plane.js";
export {
  P2PWebRTCAdapter,
  type P2PIceServer,
  type P2PMediaPlaneOptions,
  type P2PTurnConfig,
} from "./p2p-media-plane.js";

// FR-83 — self-hosted single-box mediasoup SFU media plane.
export {
  LocalMediaPlacement,
  type LocalMediaPlacementOptions,
  type MediaHome,
  type MediaPlacement,
} from "./media-placement.js";
export {
  SfuBackendError,
  type ConnectTransportInput,
  type ConsumeInput,
  type ConsumerHandle,
  type CreateWebRtcTransportInput,
  type DtlsParameters,
  type IceCandidate,
  type IceParameters,
  type MediaKind,
  type ProduceInput,
  type ProducerHandle,
  type RouterHandle,
  type RtpCapabilities,
  type RtpParameters,
  type SfuBackend,
  type SfuCodec,
  type TransportHandle,
} from "./sfu-backend.js";
export { FakeSfuBackend, type FakeSfuBackendOptions } from "./fake-sfu-backend.js";
export {
  MediasoupSfuBackend,
  type MediasoupSfuBackendOptions,
} from "./mediasoup-sfu-backend.js";
export {
  SfuMediaPlaneAdapter,
  DEFAULT_SFU_MEDIA_CODECS,
  type SfuMediaPlaneOptions,
  type SfuTransportParams,
} from "./sfu-media-plane.js";

// FR-154 — multi-box SFU placement (bus-coordinated home-node registry).
export {
  ClusterMediaPlacement,
  MEDIA_PLACEMENT_TENANT,
  type ClusterMediaPlacementOptions,
} from "./cluster-media-placement.js";

// FR-79 — call control-plane state machine + canonical schema fragment.
export {
  CallControlPlane,
  CallStateError,
  CallAuthzError,
  CallMediaUnsupportedError,
  supportsSfuMedia,
  type SfuMediaOperations,
  callActor,
  type CallActor,
  type CallAuthzErrorReason,
  type CallControlPlaneOptions,
  type CallInviteRecord,
  type CallKind,
  type CallParticipantRecord,
  type CallRoomRecord,
  type CallStateErrorReason,
  type CreateCallInput,
  type CreateCallResult,
  type JoinCallResult,
  type MediaState,
} from "./call-control-plane.js";
export {
  DEFAULT_CALL_TYPE_NAMES,
  CALL_ROOM_STATES,
  CALL_INVITE_STATES,
  buildCallSchema,
  callObjectDefs,
  callEventDefs,
  callStreamDefs,
  callSignalDefs,
  type CallInviteState,
  type CallRoomState,
  type CallTypeNames,
} from "./call-schema.js";
