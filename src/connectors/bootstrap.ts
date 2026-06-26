// Populates the connector registry at app startup by importing each connector
// module for its self-registration side-effect. server.ts imports this once
// before the connector routes resolve a connector by kind.
import "./github.js";
import "./slack.js";
