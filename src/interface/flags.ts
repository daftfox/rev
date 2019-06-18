/**
 * @interface IFlags
 * @namespace IFlags
 */
export default interface IFlags {
    serial: boolean; // enable/disable the serial service
    debug: boolean; // enable/disable debug logging
    ethernet: boolean; // enable/disable the ethernet service
    port: number; // port to bind the WebSocket service to
    ethPort: number; // port to bind the ethernet service to
}