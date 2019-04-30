import * as FirmataBoard from 'firmata';
import Logger from '../service/logger';
import CommandError from '../error/command-error';
import Timeout = NodeJS.Timeout;
import Chalk from 'chalk';
import IBoard from '../interface/board';
import IPinout from '../interface/pinout';
import IPin from "../interface/pin";


/**
 * Generic representation of devices compatible with the firmata protocol
 *
 * @namespace Board
 */
class Board implements IBoard {
    /**
     * The unique identifier by which the board will be known to the outside world. The ID is defined by the filename
     * of the firmware that is flashed to the device. The filename should look like the following example:
     * <generic_name>_<unique_identifier>.ino
     *
     * @type {string}
     * @access public
     */
    public id: string;

    /**
     * Local instance of {@link Logger}
     *
     * @access protected
     * @type {Logger}
     */
    protected log: Logger;

    /**
     * Unique identifier of the physical device's vendor (if available).
     *
     * @type {string}
     * @access public
     */
    public vendorId: string;

    /**
     * Unique identifier of the physical device's model (if available).
     *
     * @type {string}
     * @access public
     */
    public productId: string;

    /**
     * String containing the type of device the {@link Board} instance represents. This could be a generic device (thus containing type: 'Board')
     * or an instance of {@link MajorTom} (type: 'MajorTom').
     *
     * @type {string}
     * @access public
     */
    public type: string;

    /**
     * The current job the physical device is busy with. Defaults to 'IDLE' when it's not doing anything.
     *
     * @access public
     * @type {string}
     */
    public currentJob: string = "IDLE";

    /**
     * This property is used to map available methods to string representations so we can easily
     * validate and call them from elsewhere. The mapping should be obvious.
     * Currently available methods are: BLINKON, BLINKOFF and TOGGLELED.
     *
     * @type {Object}
     * @access protected
     */
    protected availableActions = {
        BLINKON: () => { this.enableBlinkLed( true ) },
        BLINKOFF: () => { this.enableBlinkLed( false ) },
        TOGGLELED: () => { this.toggleLED() },
        SETPINVALUE: ( pin: string, value: string ) => { this.setPinValue( parseInt( pin , 10), parseInt( value, 10 ) ) },
    };

    /**
     * Namespace used by the local instance of {@link Logger}
     *
     * @type {string}
     * @access protected
     */
    protected namespace: string;

    /**
     * Method that is executed as soon as the 'ready' event has been emitted by the local instance of {@link Board.firmataBoard}.
     * This method should be removed as listener by any classes that extend {@link Board}.
     *
     * @type {function}
     * @access protected
     */
    protected readyListener: () => void;

    /**
     * Local instance of {@link FirmataBoard} that is used to connect and talk to physical devices supporting the firmata protocol.
     *
     * @access protected
     * @type {FirmataBoard}
     */
    protected firmataBoard: FirmataBoard;

    /**
     * An array of intervals stored so we can clear them all at once using {@link Board.clearAllTimeouts} or {@link Board.clearAllTimers} when the moment is there.
     *
     * @access protected
     * @type {Timeout[]}
     */
    protected intervals: Timeout[] = [];

    /**
     * An array of timeouts stored so we can clear them all at once using {@link Board.clearAllTimeouts} or {@link Board.clearAllTimers} when the moment is there.
     *
     * @access protected
     * @type {Timeout[]}
     */
    protected timeouts: Timeout[] = [];

    // defaulted to Wemos D1 mini pinout for now
    /**
     * The pinout set for generic boards. This is currently set to the pinout for Wemos D1 (mini) boards, as these are
     * the ones I use during development.
     *
     * @type {IPinout}
     */
    protected pinout: IPinout = {
        LED: 2,
        RX: 13,
        TX: 15
    };

    /**
     * The ID of the interval that's executed when we blink the builtin LED.
     * This is stored to identify whether or not we're already blinking the builtin LED.
     *
     * @access private
     */
    private blinkInterval;

    /**
     * Array that is used to store the value measured by analog pins for later comparison.
     *
     * @access private
     * @type {number[]}
     */
    private previousAnalogValue: number[] = [];

    /**
     * The interval at which to send out a heartbeat. The heartbeat is used to 'test' the TCP connection with the physical
     * device. If the device doesn't respond within 2 seconds after receiving a heartbeat request, it is deemed disconnected
     * and removed from the data model until it attempts reconnecting.
     *
     * @static
     * @readonly
     * @access private
     * @type {number}
     */
    private static readonly heartbeatInterval = 3000;

    /**
     * Creates a new instance of Board and awaits a successful connection before starting its heartbeat.
     *
     * @constructor
     * @param {FirmataBoard} firmataBoard
     * @param {string} id
     */
    constructor( firmataBoard: FirmataBoard, id: string ) {
        this.firmataBoard = firmataBoard;
        this.id = id;
        this.type = this.constructor.name;
        this.namespace = `board_${ this.id }`;
        this.log = new Logger( this.namespace );

        // set analog pin sampling rate at 1 second to prevent an overload of updates
        this.firmataBoard.setSamplingInterval( 1000 );

        this.attachAnalogPinListeners();
        this.attachDigitalPinListeners();
        this.startHeartbeat();
    }

    /**
     * Method returning a string array containing the actions this device is able to execute.
     *
     * @return {string[]} String array containing the available actions
     */
    public getAvailableActions(): string[] {
        return Object.keys( this.availableActions );
    }

    /**
     * Allows the user to define a different pinout for the device than is set by default.
     * Default is defined in {@link Board.pinout}
     *
     * @param {IPinout} pinout
     * @returns {void}
     */
    public setPinout( pinout: IPinout ): void {
        Object.assign( this.pinout, pinout );
    }

    /**
     * Return an {@link IBoard}.
     *
     * @static
     * @access public
     * @param {Board} board
     * @returns {IBoard} An object representing a {@link IBoard} instance, but without the overhead and methods.
     */
    public static toDiscrete( board: Board ): IBoard {
        return {
            id: board.id,
            vendorId: board.vendorId,
            productId: board.productId,
            type: board.type,
            currentJob: board.currentJob,
            commands: board.getAvailableActions(),
            pins: board.firmataBoard.pins
                .map( ( pin: FirmataBoard.Pins, index: number ) => Object.assign( { pinNumber: index, analog: pin.analogChannel != 127 }, pin ) )
                .filter( ( pin: IPin ) => pin.supportedModes.length > 0 )
        };
    }

    /**
     * Return an array of {@link IBoard}.
     *
     * @static
     * @access public
     * @param {Board[]} boards
     * @returns {IBoard[]}
     */
    public static toDiscreteArray( boards: Board[] ): IBoard[] {
        return boards.map( Board.toDiscrete );
    }

    /**
     * Execute an action. Checks if the action is actually available before attempting to execute it.
     *
     * @access public
     * @param {string} action
     * @param {string} parameter
     * @returns {void}
     */
    public executeAction( action: string, ...parameter: string[] ): void {
        if ( !this.isAvailableAction( action ) ) throw new CommandError( `'${ Chalk.rgb( 67,230,145 ).bold( action ) }' is not a valid action.` );

        this.log.debug( `Executing method ${ Chalk.rgb( 67,230,145 ).bold( action ) }.` );

        this.availableActions[ action ]( parameter );
        this.firmataBoard.emit( 'update' );
    }

    /**
     * Clear all timeouts and intervals. This is required when a physical device is disconnected.
     *
     * @returns {void}
     */
    public clearAllTimers(): void {
        this.clearAllIntervals();
        this.clearAllTimeouts();
        this.firmataBoard.removeAllListeners();
    }

    /**
     * Clear an interval that was set by this {@link Board} instance.
     *
     * @param {NodeJS.Timeout} interval
     * @returns {void}
     */
    protected clearInterval( interval: Timeout ): void {
        this.intervals.splice( this.intervals.indexOf( interval ), 1 );
        clearInterval( interval );
    }

    /**
     * Clear a timeout that was set by this {@link Board} instance.
     *
     * @param {NodeJS.Timeout} timeout
     * @returns {void}
     */
    protected clearTimeout( timeout: Timeout ): void {
        this.timeouts.splice( this.timeouts.indexOf( timeout ), 1 );
        clearTimeout( timeout );
    }

    /**
     * Enable or disable the builtin LED blinking
     *
     * @param {boolean} enable
     * @access protected
     * @returns {void}
     */
    protected enableBlinkLed( enable: boolean ): void {
        if ( enable ) {
            if ( this.blinkInterval ) {
                this.log.warn( `LED blink is already enabled.` );
                return;
            }

            // set the current job to 'BLINKON'
            this.currentJob = "BLINKON";

            this.blinkInterval = setInterval(
                this.toggleLED.bind( this ),
                500
            );

            this.intervals.push( this.blinkInterval );
        } else {

            // reset the current job to 'IDLE'
            this.resetCurrentJob();
            this.clearInterval( this.blinkInterval );
            this.blinkInterval = null;
        }
    }

    /**
     * Toggle the builtin LED on / off. Turns it on if it's off and vice versa.
     *
     * @access protected
     * @returns {void}
     */
    protected toggleLED(): void {
        this.setPinValue( this.pinout.LED, this.firmataBoard.pins[ this.pinout.LED ].value === FirmataBoard.PIN_STATE.HIGH ? FirmataBoard.PIN_STATE.LOW : FirmataBoard.PIN_STATE.HIGH );
    }

    /**
     * Starts an interval requesting the physical board to send its firmware version every 10 seconds.
     * Emits a 'disconnect' event on the local {@link Board.firmataBoard} instance if the device fails to respond within 2 seconds of this query being sent.
     * The device is deemed disconnected and removed from the data model until it attempts reconnecting after the disconnect event is emitted.
     *
     * @access protected
     * @emits FirmataBoard.disconnect
     * @returns {void}
     */
    protected startHeartbeat(): void {
        const heartbeat = setInterval( () => {

            // set a timeout to emit a disconnect event if the physical device doesn't reply within 2 seconds
            const heartbeatTimeout = setTimeout( () => {
                this.log.warn( `Heartbeat timeout.` );

                // emit disconnect event after which the board is removed from the data model
                this.firmataBoard.emit( 'disconnect' );
                this.clearInterval( heartbeat );
                this.clearTimeout( heartbeatTimeout );
            }, 2000 );

            this.timeouts.push( heartbeatTimeout );

            // we utilize the queryFirmware method to emulate a heartbeat
            this.firmataBoard.queryFirmware( () => {
                this.clearTimeout( heartbeatTimeout );
            } );
        }, Board.heartbeatInterval );
        this.intervals.push ( heartbeat );
    }

    /**
     * Sets {@link Board.currentJob} to 'IDLE'
     *
     * @access protected
     * @returns {void}
     */
    protected resetCurrentJob(): void {
        this.currentJob = "IDLE";
    }

    /**
     * Writes a character byte-array to a device's serial UART interface.
     *
     * @access private
     * @param {string} payload String to send
     * @param {FirmataBoard.SERIAL_PORT_ID} serialPort Serial port on which to send
     * @returns {void}
     */
    protected serialWrite( serialPort: FirmataBoard.SERIAL_PORT_ID, payload: string ): void {
        const bytes = [...payload].map( str => str.charCodeAt(0) );
        this.firmataBoard.serialWrite( serialPort, bytes );
    }

    /**
     * Emits an 'update' event
     *
     * @emits FirmataBoard.update
     * @returns {void}
     */
    protected emitUpdate(): void {
        this.firmataBoard.emit( 'update' );
    }

    /**
     * Write a value to a pin. Automatically distinguishes between analog and digital pins and calls the corresponding methods.
     *
     * @access protected
     * @param {number} pin
     * @param {number} value
     * @returns {void}
     */
    protected setPinValue( pin: number, value: number ): void {
        if ( this.isAnalogPin( pin ) ) {
            this.firmataBoard.analogWrite( pin, value );
        } else if ( this.isDigitalPin( pin ) ) {
            if ( value !== FirmataBoard.PIN_STATE.HIGH && value !== FirmataBoard.PIN_STATE.LOW ) {
                this.log.warn( `Tried to write value ${ value } to digital pin ${ pin }. Only values 1 (HIGH) or 0 (LOW) are allowed.` );
            } else {
                this.firmataBoard.digitalWrite( pin, value );
            }
        }
        this.emitUpdate();
    }

    /**
     * Attaches listeners to all digital pins whose modes ({@link FirmataBoard.PIN_MODE}) are setup as INPUT pins.
     * Once the pin's value changes an 'update' event will be emitted by calling the {@link Board.emitUpdate} method.
     *
     * @access private
     * @returns {void}
     */
    private attachDigitalPinListeners(): void {
        this.firmataBoard.pins.forEach( ( pin: FirmataBoard.Pins, index: number ) => {
            if ( this.isDigitalPin( index ) ) {
                this.firmataBoard.digitalRead( index, this.emitUpdate.bind( this ) )
            }
        } );
    }

    /**
     * Attaches listeners to all analog pins.
     * Once the pin's value changes an 'update' event will be emitted by calling the {@link Board.emitUpdate} method.
     *
     * @access private
     * @returns {void}
     */
    private attachAnalogPinListeners(): void {
        this.firmataBoard.analogPins.forEach( ( pin: number, index: number )  => {
            this.firmataBoard.analogRead( index, ( value: number ) => {
                this.compareAnalogReadout( pin, value );
            } );
        } );
    }

    /**
     * Calls {@link Board.emitUpdate} if the current value differs from the previously measured value.
     *
     * @param {number} pinIndex
     * @param {number} value
     * @returns {void}
     */
    private compareAnalogReadout( pinIndex: number, value: number ): void {
        if ( this.previousAnalogValue[ pinIndex ] !== value ) {
            this.previousAnalogValue[ pinIndex ] = value;
            this.emitUpdate();
        }
    }

    /**
     * Clear all intervals stored in {@link Board.intervals}.
     *
     * @access private
     * @returns {void}
     */
    private clearAllIntervals(): void {
        this.intervals.forEach( interval => clearInterval( interval ) );
        this.intervals = [];
    }

    /**
     * Clear all timeouts stored in {@link Board.timeouts}.
     *
     * @access private
     * @returns {void}
     */
    private clearAllTimeouts(): void {
        this.timeouts.forEach( timeout => clearTimeout( timeout ) );
        this.timeouts = [];
    }

    /**
     * Check if the action received is valid from the list of {@link Board.availableActions}.
     *
     * @access private
     * @param {string} action The command to check for availability
     * @returns {boolean} True if the command is valid, false if not
     */
    private isAvailableAction( action: string ): boolean {
        return this.getAvailableActions().indexOf( action ) >= 0;
    }

    /**
     * Checks whether a pin is a digital pin.
     *
     * @access private
     * @param {number} pinIndex
     * @returns {boolean}
     */
    private isDigitalPin( pinIndex: number ): boolean {
        const pin = this.firmataBoard.pins[ pinIndex ];
        return pin.analogChannel === 127 && pin.supportedModes.length > 0 && !pin.supportedModes.includes( FirmataBoard.PIN_MODE.ANALOG );
    }

    /**
     * Check whether a pin is an analog pin.
     *
     * @access private
     * @param {number} pinIndex
     * @returns {boolean}
     */
    private isAnalogPin( pinIndex: number ): boolean {
        const pin = this.firmataBoard.pins[ pinIndex ];
        return pin.supportedModes.includes( FirmataBoard.PIN_MODE.ANALOG );
    }
}

export default Board;