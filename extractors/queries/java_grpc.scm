;; Detect gRPC service implementation classes
(class_declaration
  name: (identifier) @service.impl_name
  interfaces: (super_interfaces
    (type_list
      (type_identifier) @service.grpc_base_interface))
  (#match? @service.grpc_base_interface "ImplBase$")) @grpc.service_def

;; Detect @GrpcService or Spring @Service annotations
(marker_annotation
  name: (identifier) @annotation.name
  (#match? @annotation.name "^(GrpcService|Service)$")) @grpc.service_annotation

;; Detect gRPC stub method calls / invocations
(method_invocation
  object: (identifier) @stub.instance
  name: (identifier) @stub.rpc_method
  arguments: (argument_list)) @grpc.stub_call

;; Detect import declarations matching generated proto/grpc packages
(import_declaration
  (scoped_identifier) @import.path
  (#match? @import.path "(grpc|proto|pb)")) @grpc.proto_import
