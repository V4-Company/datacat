import protobuf from "protobufjs";

// Protobuf message shapes (field names, numbers and types) needed to decode the Datadog Agent's payloads:
//   MetricPayload, SketchPayload: from github.com/DataDog/agent-payload (proto/metrics/agent_payload.proto),
//     Copyright (c) 2017, Datadog, Inc., BSD 3-Clause License (full text in NOTICE).
//   AgentPayload, TracerPayload, TraceChunk, Span and the Idx* string-table messages: from
//     github.com/DataDog/datadog-agent (pkg/proto/datadog/trace), Copyright 2016-present Datadog, Inc.,
//     Apache License 2.0.
const descriptor = {
  nested: {
    MetricPayload: {
      fields: { series: { rule: "repeated", type: "MetricSeries", id: 1 } },
      nested: {
        MetricPoint: { fields: { value: { type: "double", id: 1 }, timestamp: { type: "int64", id: 2 } } },
        Resource: { fields: { type: { type: "string", id: 1 }, name: { type: "string", id: 2 } } },
        MetricSeries: {
          fields: {
            resources: { rule: "repeated", type: "Resource", id: 1 },
            metric: { type: "string", id: 2 },
            tags: { rule: "repeated", type: "string", id: 3 },
            points: { rule: "repeated", type: "MetricPoint", id: 4 },
            type: { type: "int32", id: 5 },
            unit: { type: "string", id: 6 },
            source_type_name: { type: "string", id: 7 },
            interval: { type: "int64", id: 8 },
          },
        },
      },
    },
    SketchPayload: {
      fields: { sketches: { rule: "repeated", type: "Sketch", id: 1 } },
      nested: {
        Sketch: {
          fields: {
            metric: { type: "string", id: 1 },
            host: { type: "string", id: 2 },
            tags: { rule: "repeated", type: "string", id: 4 },
            dogsketches: { rule: "repeated", type: "Dogsketch", id: 7 },
          },
          nested: {
            Dogsketch: {
              fields: {
                ts: { type: "int64", id: 1 },
                cnt: { type: "int64", id: 2 },
                min: { type: "double", id: 3 },
                max: { type: "double", id: 4 },
                avg: { type: "double", id: 5 },
                sum: { type: "double", id: 6 },
                k: { rule: "repeated", type: "sint32", id: 7 },
                n: { rule: "repeated", type: "uint32", id: 8 },
              },
            },
          },
        },
      },
    },
    AgentPayload: {
      fields: {
        hostName: { type: "string", id: 1 },
        env: { type: "string", id: 2 },
        tracerPayloads: { rule: "repeated", type: "TracerPayload", id: 5 },
        tags: { keyType: "string", type: "string", id: 6 },
        agentVersion: { type: "string", id: 7 },
        // Agent 7.7x+ sends traces here instead of tracerPayloads (string-table encoding, datadog/trace/idx)
        idxTracerPayloads: { rule: "repeated", type: "IdxTracerPayload", id: 11 },
      },
    },
    IdxAnyValue: {
      oneofs: { value: { oneof: ["stringValueRef", "boolValue", "doubleValue", "intValue", "bytesValue", "arrayValue", "keyValueList"] } },
      fields: {
        stringValueRef: { type: "uint32", id: 1 },
        boolValue: { type: "bool", id: 2 },
        doubleValue: { type: "double", id: 3 },
        intValue: { type: "int64", id: 4 },
        bytesValue: { type: "bytes", id: 5 },
        arrayValue: { type: "IdxArrayValue", id: 6 },
        keyValueList: { type: "IdxKeyValueList", id: 7 },
      },
    },
    IdxKeyValue: { fields: { key: { type: "uint32", id: 1 }, value: { type: "IdxAnyValue", id: 2 } } },
    IdxArrayValue: { fields: { values: { rule: "repeated", type: "IdxAnyValue", id: 1 } } },
    IdxKeyValueList: { fields: { keyValues: { rule: "repeated", type: "IdxKeyValue", id: 1 } } },
    IdxSpan: {
      fields: {
        serviceRef: { type: "uint32", id: 1 },
        nameRef: { type: "uint32", id: 2 },
        resourceRef: { type: "uint32", id: 3 },
        spanID: { type: "fixed64", id: 4 },
        parentID: { type: "uint64", id: 5 },
        start: { type: "fixed64", id: 6 },
        duration: { type: "uint64", id: 7 },
        error: { type: "bool", id: 8 },
        attributes: { keyType: "uint32", type: "IdxAnyValue", id: 9 },
        typeRef: { type: "uint32", id: 10 },
        envRef: { type: "uint32", id: 13 },
        versionRef: { type: "uint32", id: 14 },
        componentRef: { type: "uint32", id: 15 },
        kind: { type: "int32", id: 16 },
      },
    },
    IdxTraceChunk: {
      fields: {
        priority: { type: "int32", id: 1 },
        originRef: { type: "uint32", id: 2 },
        attributes: { keyType: "uint32", type: "IdxAnyValue", id: 3 },
        spans: { rule: "repeated", type: "IdxSpan", id: 4 },
        droppedTrace: { type: "bool", id: 5 },
        traceID: { type: "bytes", id: 6 },
        samplingMechanism: { type: "uint32", id: 7 },
      },
    },
    IdxTracerPayload: {
      fields: {
        strings: { rule: "repeated", type: "string", id: 1 },
        containerIDRef: { type: "uint32", id: 2 },
        languageNameRef: { type: "uint32", id: 3 },
        languageVersionRef: { type: "uint32", id: 4 },
        tracerVersionRef: { type: "uint32", id: 5 },
        runtimeIDRef: { type: "uint32", id: 6 },
        envRef: { type: "uint32", id: 7 },
        hostnameRef: { type: "uint32", id: 8 },
        appVersionRef: { type: "uint32", id: 9 },
        attributes: { keyType: "uint32", type: "IdxAnyValue", id: 10 },
        chunks: { rule: "repeated", type: "IdxTraceChunk", id: 11 },
      },
    },
    TracerPayload: {
      fields: {
        containerID: { type: "string", id: 1 },
        languageName: { type: "string", id: 2 },
        languageVersion: { type: "string", id: 3 },
        tracerVersion: { type: "string", id: 4 },
        runtimeID: { type: "string", id: 5 },
        chunks: { rule: "repeated", type: "TraceChunk", id: 6 },
        tags: { keyType: "string", type: "string", id: 7 },
        env: { type: "string", id: 8 },
        hostname: { type: "string", id: 9 },
        appVersion: { type: "string", id: 10 },
      },
    },
    TraceChunk: {
      fields: {
        priority: { type: "int32", id: 1 },
        origin: { type: "string", id: 2 },
        spans: { rule: "repeated", type: "Span", id: 3 },
        tags: { keyType: "string", type: "string", id: 4 },
        droppedTrace: { type: "bool", id: 5 },
      },
    },
    Span: {
      fields: {
        service: { type: "string", id: 1 },
        name: { type: "string", id: 2 },
        resource: { type: "string", id: 3 },
        traceID: { type: "uint64", id: 4 },
        spanID: { type: "uint64", id: 5 },
        parentID: { type: "uint64", id: 6 },
        start: { type: "int64", id: 7 },
        duration: { type: "int64", id: 8 },
        error: { type: "int32", id: 9 },
        meta: { keyType: "string", type: "string", id: 10 },
        metrics: { keyType: "string", type: "double", id: 11 },
        type: { type: "string", id: 12 },
      },
    },
  },
};

const root = protobuf.Root.fromJSON(descriptor as any);
export const MetricPayload = root.lookupType("MetricPayload");
export const SketchPayload = root.lookupType("SketchPayload");
export const AgentPayload = root.lookupType("AgentPayload");

export function decodeProto(type: protobuf.Type, buf: Buffer): any {
  const msg = type.decode(buf);
  return type.toObject(msg, { longs: String, defaults: true, arrays: true, objects: true });
}
