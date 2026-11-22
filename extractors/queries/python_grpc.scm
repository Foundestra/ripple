;; Detect Python gRPC proto/stub imports
(import_from_statement
  module_name: (dotted_name) @import.module
  name: (dotted_name) @import.symbol
  (#match? @import.module "(pb2|pb2_grpc)")) @grpc.proto_import

;; Detect add_*_to_server calls
(call
  function: (attribute
    object: (identifier) @registration.module
    attribute: (identifier) @registration.func
    (#match? @registration.func "^add_.*_to_server$"))
  arguments: (argument_list
    (identifier) @service.handler_class
    (identifier) @server.instance)) @grpc.server_registration

;; Detect client stub creation (e.g. PaymentServiceStub(channel))
(call
  function: (attribute
    object: (identifier) @stub.module
    attribute: (identifier) @stub.class
    (#match? @stub.class "Stub$"))
  arguments: (argument_list
    (identifier) @channel.instance)) @grpc.client_stub_init
