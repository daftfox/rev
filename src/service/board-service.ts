import * as EtherPort from 'etherport';
import Boards from "../model/boards";
import Board from "../domain/board";
import Logger from "./logger";
import MajorTom from "../domain/major-tom";
import * as FirmataBoard from 'firmata';

/**
 * A basic board-service that implements a connectToBoard method
 * @classdesc // todo
 */
class BoardService {

    /** @access private */
    private model: Boards;

    /**
     * @constructor
     * @param {Boards} model - Data model that implements an addBoard and removeBoard method.
     */
    constructor( model: Boards ) {
        this.model = model;
    }

    /**
     * Sets up a connection to a board.
     *
     * @param {EtherPort | string} port - An EtherPort object or serial port address
     * @param {function(boolean):void} boardConnectedCallback - Callback for when device successfully connects.
     * @param {function():void} boardDisconnectedCallback
     */
    protected connectToBoard( port: EtherPort | string, boardConnectedCallback?: ( boolean ) => void, boardDisconnectedCallback?: () => void ): void {
        let board: Board;
        const firmataBoard = new FirmataBoard( port );
        const id = ( typeof port === "object" ? port.path.split( ': ' )[ 1 ] : port );

        /*
         * Set a 10 second timeout.
         * The device is deemed unsupported if a connection could not be made within that period.
         */
        const connectionTimeout = setTimeout( _ => {
            Logger.warn( '' ,'Timeout connecting to board' );
            board = null;
            firmataBoard.removeAllListeners(); // "What do we say to the God of memory leaks? Not today."
            boardConnectedCallback( false );
        }, 10000) ;

        /*
         * I perform some dark magic here.
         * As there are standard devices that offer functionality, I take a look at the name of the firmware that
         * was installed. By default an instance of Board is created, but with these standard devices I instantiate
         * an object of its corresponding class.
         *
         * The firmware name is defined by the name of the Arduino sketch.
         * For now the following devices have a tailor made class:
         * - Major Tom ( MajorTom.ino )
         */
        firmataBoard.on( 'queryfirmware', () => {
            const type = firmataBoard.firmware.name.replace( '.ino', '' );

            switch (type) {
                case 'MajorTom':
                    board = new MajorTom( firmataBoard, id );
                    break;
                default:
                    board = new Board( firmataBoard, id );
            }
        } );

        /*
         * A proper connection was made and the board is passed to the callback method.
         */
        firmataBoard.on( 'ready', () => {
            this.model.addBoard( board );
            boardConnectedCallback( board );
            clearTimeout( connectionTimeout );
        } );

        /*
         * Although I have never seen this event getting properly fired, I'm still implementing this.
         * Disconnects usually/only happen when the connection is broken up in an unplanned way.
         * I try to capture disconnected in a different way
         */
        firmataBoard.on( 'disconnect', () => {
            // console.log( "BOARD DISCONNECTED" );
            this.model.removeBoard( board );
            boardDisconnectedCallback()
        } );

        /*
         * The same goes for this one.
         */
        firmataBoard.on('close', () => {
            // console.log( "BOARD CLOSED CONNECTION" );
            this.model.removeBoard( board );
            boardDisconnectedCallback()
        } );
    }
}

export default BoardService;