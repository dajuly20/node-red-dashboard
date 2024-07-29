const fs = require('fs')
const path = require('path')

const v = require('../../package.json').version
const datastore = require('../store/data.js')
const statestore = require('../store/state.js')
const { appendTopic, addConnectionCredentials } = require('../utils/index.js')

// from: https://stackoverflow.com/a/28592528/3016654
function join (...paths) {
    return paths.map(function (element) {
        return element.replace(/^\/|\/$/g, '')
    }).join('/')
}

/**
 * Check if an object has a property
 * TODO: move to test-able utility lib
 * @param {Object} obj - Object to check for property
 * @param {String} prop - Property to check for
 * @returns {boolean}
 */
function hasProperty (obj, prop) {
    return Object.prototype.hasOwnProperty.call(obj, prop)
}

module.exports = function (RED) {
    const express = require('express')
    const { Server } = require('socket.io')

    datastore.setConfig(RED)
    statestore.setConfig(RED)

    /**
     * @typedef {import('socket.io/dist').Socket} Socket
     * @typedef {import('socket.io/dist').Server} Server
     */

    // store state that can maintain cross re-deployments
    const uiShared = {
        app: null,
        httpServer: null,
        /** @type { Server } */
        ioServer: null,
        /** @type {Object.<string, Socket>} */
        connections: {},
        settings: {},
        contribs: {}
    }

    /**
     * Initialise the Express Server and SocketIO Server in Singleton Pattern
     * @param {Object} node - Node-RED Node
     * @param {Object} config - Node-RED Node Config
     */
    function init (node, config) {
        node.uiShared = uiShared // ensure we have a uiShared object on the node (for testing mainly)

        if (!config.acceptsClientConfig) {
            // for those upgrading, we need this for backwards compatibility
            config.acceptsClientConfig = ['ui-control', 'ui-notification']
        }

        if (!('includeClientData' in config)) {
            // for those upgrading, we need this for backwards compatibility
            config.includeClientData = true
        }

        // expose these properties at runtime
        node.acceptsClientConfig = config.acceptsClientConfig // which node types can be scoped to a specific client
        node.includeClientData = config.includeClientData // whether to include client data in msg payloads

        // eventually check if we have routes used, so we can support multiple base UIs
        if (!uiShared.app) {
            uiShared.app = RED.httpNode || RED.httpAdmin
            uiShared.httpServer = RED.server

            // Use the 'dashboard' settings if present, otherwise fallback
            // to node-red-dashboard 'ui' settings object.
            uiShared.settings = RED.settings.dashboard || RED.settings.ui || {}

            // Default no-op middleware
            uiShared.httpMiddleware = function (req, res, next) { next() }
            if (uiShared.settings.middleware) {
                if (typeof uiShared.settings.middleware === 'function' || Array.isArray(uiShared.settings.middleware)) {
                    uiShared.httpMiddleware = uiShared.settings.middleware
                }
            }

            /**
             * Load in third party widgets
             */
            let packagePath, packageJson
            if (RED.settings?.userDir) {
                packagePath = path.join(RED.settings.userDir, 'package.json')
                packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
            } else {
                node.log('Cannot import third party widgets. No access to Node-RED package.json')
            }

            if (packageJson && packageJson.dependencies) {
                Object.entries(packageJson.dependencies)?.filter(([packageName, _packageVersion]) => {
                    return packageName.includes('node-red-dashboard-2-')
                }).map(([packageName, _packageVersion]) => {
                    const modulePath = path.join(RED.settings.userDir, 'node_modules', packageName)
                    const packagePath = path.join(modulePath, 'package.json')
                    // get third party package.json
                    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
                    if (packageJson?.['node-red-dashboard-2']) {
                        // loop over object of widgets
                        Object.entries(packageJson['node-red-dashboard-2'].widgets).forEach(([widgetName, widgetConfig]) => {
                            uiShared.contribs[widgetName] = {
                                package: packageName,
                                name: widgetName,
                                src: widgetConfig.output,
                                component: widgetConfig.component
                            }
                        })
                    }
                    return packageJson
                })
            }

            /**
             * Configure Web Server to handle UI traffic
             */

            uiShared.app.use(config.path, uiShared.httpMiddleware, express.static(path.join(__dirname, '../../dist')))

            uiShared.app.get(config.path + '/_setup', uiShared.httpMiddleware, (req, res) => {
                let socketPath = join(RED.settings.httpNodeRoot, config.path, 'socket.io')
                // if no leading /, add one (happens sometimes depending on httpNodeRoot in settings.js)
                if (socketPath[0] !== '/') {
                    socketPath = '/' + socketPath
                }
                let resp = {
                    RED: {
                        httpAdminRoot: RED.settings.httpAdminRoot,
                        httpNodeRoot: RED.settings.httpNodeRoot
                    },
                    socketio: {
                        path: socketPath
                    }
                }
                // Hook API - onSetup(RED, config, req, res)
                RED.plugins.getByType('node-red-dashboard-2').forEach(plugin => {
                    if (plugin.hooks?.onSetup) {
                        const _resp = plugin.hooks.onSetup(config, req, res)
                        resp = { ...resp, ..._resp }
                    }
                })
                return res.json(resp)
            })

            // debugging endpoints
            uiShared.app.get(config.path + '/_debug/datastore/:itemid', uiShared.httpMiddleware, (req, res) => {
                return res.json(datastore.get(req.params.itemid))
            })

            uiShared.app.get(config.path + '/_debug/statestore/:itemid', uiShared.httpMiddleware, (req, res) => {
                return res.json(statestore.getAll(req.params.itemid))
            })

            // serve dashboard
            uiShared.app.get(config.path, uiShared.httpMiddleware, (req, res) => {
                res.sendFile(path.join(__dirname, '../../dist/index.html'))
            })

            uiShared.app.get(config.path + '/*', uiShared.httpMiddleware, (req, res) => {
                res.sendFile(path.join(__dirname, '../../dist/index.html'))
            })

            node.log(`Node-RED Dashboard 2.0 (v${v}) started at ${config.path}`)

            /**
             * Create IO Server for comms between Node-RED and UI
             */
            if (RED.settings.httpNodeRoot !== false) {
                const root = RED.settings.httpNodeRoot || '/'
                const fullPath = join(root, config.path)
                const socketIoPath = join('/', fullPath, 'socket.io')
                /** @type {import('socket.io/dist').ServerOptions} */
                const serverOptions = {
                    path: socketIoPath,
                    maxHttpBufferSize: uiShared.settings.maxHttpBufferSize || 1e6 // SocketIO default size
                }
                // console.log('Creating socket.io server at path', socketIoPath) // disable - noisy in tests
                // store reference to the SocketIO Server
                uiShared.ioServer = new Server(uiShared.httpServer, serverOptions)
                uiShared.ioServer.setMaxListeners(0) // prevent memory leak warning // TODO: be more smart about this!

                if (typeof uiShared.settings.ioMiddleware === 'function') {
                    uiShared.ioServer.use(uiShared.settings.ioMiddleware)
                } else if (Array.isArray(uiShared.settings.ioMiddleware)) {
                    uiShared.settings.ioMiddleware.forEach(function (ioMiddleware) {
                        uiShared.ioServer.use(ioMiddleware)
                    })
                } else {
                    uiShared.ioServer.use(function (socket, next) {
                        if (socket.client.conn.request.url.indexOf('transport=websocket') !== -1) {
                            // Reject direct websocket requests
                            socket.client.conn.close()
                            return
                        }
                        if (socket.handshake.xdomain === false) {
                            return next()
                        } else {
                            socket.disconnect(true)
                        }
                    })
                }
                const bindOn = RED.server ? 'bound to Node-RED port' : 'on port ' + node.port
                node.log('Created socket.io server ' + bindOn + ' at path ' + socketIoPath)
            } else {
                node.warn('Cannot create UI Base node when httpNodeRoot set to false')
            }
        }
    }

    /**
     * Close the SocketIO Server
     */
    function close (node, done) {
        if (!uiShared.ioServer) {
            done()
            return
        }

        // determine if any ui-pages are left, if so, don't close the server
        const baseNodes = []
        const pageNodes = []
        const themes = []
        RED.nodes.eachNode(n => {
            if (n.type === 'ui-page' || n.type === 'ui-link') {
                pageNodes.push(n)
            } else if (n.type === 'ui-base' && n.id !== node.id) {
                baseNodes.push(n)
            } else if (n.type === 'ui-theme') {
                themes.push(n)
            }
        })

        if (pageNodes.length > 0) {
            // there are still ui-pages, so don't close the server
            done()
            return
        }
        node.ui.pages.clear()// ensure we clear out any pages that may have been left over
        // since there are no pages, we can assume widgets and groups are also gone
        node.ui.widgets.clear()
        node.ui.groups.clear()

        if (baseNodes.length > 0) {
            // there are still other ui-base nodes, don't close the server
            done()
            return
        }

        // as there are no more instances of ui-page and this is the last ui-base, close the server
        uiShared.ioServer.removeAllListeners()
        uiShared.ioServer.disconnectSockets(true)
        // tidy up
        if (themes.length === 0) {
            node.ui.themes.clear()
        }
        node.ui.dashboards.clear() // ensure we clear out any dashboards that may have been left over
        node.uiShared = null // remove reference to ui object
        done && done()
    }

    /**
     * UI Base Node Constructor. Called each time Node-RED deploy creates / recreates a u-base node.
     * * _whether this constructor is called depends on if there are any changes to THIS node_
     * * _A full Deploy will always call this function as every node is destroyed and re-created_
     * @param {Object} n - Node-RED node configuration as entered in the nodes editor
     */
    function UIBaseNode (n) {
        RED.nodes.createNode(this, n)
        const node = this

        node._created = Date.now()

        n.root = RED.settings.httpNodeRoot || '/'

        /** @type {Object.<string, Socket>} */
        // node.connections = {} // store socket.io connections for this node
        // // re-map existing connections for this base node
        for (const id in uiShared.connections) {
            const socket = uiShared.connections[id]
            if (uiShared.connections[id]._baseId === node.id) {
                // re establish event handlers
                socket.on('widget-send', onSend.bind(null, socket))
                socket.on('widget-action', onAction.bind(null, socket))
                socket.on('widget-change', onChange.bind(null, socket))
                socket.on('widget-load', onLoad.bind(null, socket))
            }
        }
        /** @type {NodeJS.Timeout} */
        node.emitConfigRequested = null // used to debounce requests to emitConfig

        // Configure & Run Express Server
        init(node, n)

        /**
         * Emit an event to all connected UIs
         * @param {String} event
         * @param {Object} msg
         * @param {Object} wNode - the Node-RED node that is emitting the event
         */
        function emit (event, msg, wNode) {
            Object.values(uiShared.connections).forEach(conn => {
                if (canSendTo(conn, wNode, msg)) {
                    conn.emit(event, msg)
                }
            })
        }

        // surface this so that other nodes can emit messages directly
        node.emit = emit

        /**
         * Checks, given a received msg, and the associated SocketIO connection
         * whether the msg has been configured to only be sent to particular connections
         * @param {*} conn   - SocketIO Connection Object
         * @param {*} wNode  - The Node-RED node we are sending this to
         * @param {*} msg    - The msg to be sent
         * @returns {Boolean} - Whether the msg can be sent to this connection
         */
        function canSendTo (conn, wNode, msg) {
            const nodeAllowsConstraints = wNode ? n.acceptsClientConfig?.includes(wNode.type) : true
            return (nodeAllowsConstraints && isValidConnection(conn, msg)) || !nodeAllowsConstraints
        }

        /**
         * Checks, given a received msg, and the associated SocketIO connection
         * whether the msg has been configured to only be sent to particular connections
         * @param {*} conn - SocketIO Connection Object
         * @param {*} msg  -
         */
        function isValidConnection (conn, msg) {
            const checks = []
            // loop over plugins and check if any have defined a custom isValidConnection function
            // if so, use that to determine if the connection is valid
            for (const plugin of RED.plugins.getByType('node-red-dashboard-2')) {
                if (plugin.hooks?.onIsValidConnection) {
                    checks.push(plugin.hooks.onIsValidConnection(conn, msg))
                }
            }
            // conduct the core check too
            if (msg._client?.socketId) {
                // if a particular socketid has been defined,
                // we only send comms on the connection that matches that id
                checks.push(msg._client?.socketId === conn.id)
            }
            // ensure all checks validate sending this
            return !checks.length || !checks.includes(false)
        }

        /**
         * Emit UI Config to all connected UIs
         * @param {Socket} socket - socket.io socket connecting to the server
         */
        function emitConfig (socket) {
            // loop over widgets - check statestore if we've had any dynamic properties set
            for (const [id, widget] of node.ui.widgets) {
                const state = statestore.getAll(id)
                if (state) {
                    // merge the statestore with our props to account for dynamically set properties:
                    widget.props = { ...widget.props, ...state }
                    widget.state = { ...widget.state, ...state }
                }
            }

            // loop over pages - check statestore if we've had any dynamic properties set
            for (const [id, page] of node.ui.pages) {
                const state = statestore.getAll(id)
                if (state) {
                    // merge the statestore with our props to account for dynamically set properties:
                    node.ui.pages.set(id, { ...page, ...state })
                }
            }

            // loop over groups - check statestore if we've had any dynamic properties set
            for (const [id, group] of node.ui.groups) {
                const state = statestore.getAll(id)
                if (state) {
                    // merge the statestore with our props to account for dynamically set properties:
                    node.ui.groups.set(id, { ...group, ...state })
                }
            }

            // pass the connected UI the UI config
            socket.emit('ui-config', node.id, {
                dashboards: Object.fromEntries(node.ui.dashboards),
                heads: Object.fromEntries(node.ui.heads),
                pages: Object.fromEntries(node.ui.pages),
                themes: Object.fromEntries(node.ui.themes),
                groups: Object.fromEntries(node.ui.groups),
                widgets: Object.fromEntries(node.ui.widgets)
            })
        }

        // remove event handler socket listeners for a given socket connection
        function cleanupEventHandlers (socket) {
            try {
                socket.removeAllListeners('widget-action')
            } catch (_error) { /* do nothing */ }
            try {
                socket.removeAllListeners('widget-change')
            } catch (_error) { /* do nothing */ }
            try {
                socket.removeAllListeners('widget-load')
            } catch (_error) { /* do nothing */ }
            try {
                socket.removeAllListeners('widget-send')
            } catch (_error) { /* do nothing */ }
            try {
                socket.removeAllListeners('disconnect')
            } catch (_error) { /* do nothing */ }

            // check if any widgets have defined custom socket events
            // remove their listeners to make sure we clean up properly
            node.ui?.widgets?.forEach((widget) => {
                if (widget.hooks?.onSocket) {
                    for (const [eventName] of Object.entries(widget.hooks.onSocket)) {
                        try {
                            socket.removeAllListeners(eventName)
                        } catch (_error) { /* do nothing */ }
                    }
                }
            })
        }

        function setupEventHandlers (socket, onConnection) {
            socket.on('widget-send', onSend.bind(null, socket))
            socket.on('widget-action', onAction.bind(null, socket))
            socket.on('widget-change', onChange.bind(null, socket))
            socket.on('widget-load', onLoad.bind(null, socket))

            // check if any widgets have defined custom socket events
            // most common with third-party widgets that are not part of core Dashboard 2.0
            const registered = [] // track which widget types we've already subscribed for
            node.ui?.widgets?.forEach((widget) => {
                if (widget.hooks?.onSocket) {
                    for (const [eventName, handler] of Object.entries(widget.hooks.onSocket)) {
                        // we only need add the listener for a given event type the once
                        if (eventName === 'connection') {
                            if (onConnection) {
                                // these handlers are setup as part of an onConnection event, so trigegr these now
                                handler(socket)
                            }
                        } else {
                            widget._onSocketHandlers = widget._onSocketHandlers || {}
                            widget._onSocketHandlers[eventName] = handler.bind(null, socket)
                            socket.on(eventName, widget._onSocketHandlers[eventName])
                        }
                    }
                    registered.push(widget.type)
                }
            })

            // handle disconnection
            socket.on('disconnect', reason => {
                cleanupEventHandlers(socket)
                delete uiShared.connections[socket.id]
                node.log(`Disconnected ${socket.id} due to ${reason}`)
            })
        }

        /**
         * on connection handler for SocketIO
         * @param {Socket} socket socket.io socket connecting to the server
         */
        function onConnection (socket) {
            // record mapping from connection to he ui-base node
            socket._baseId = node.id

            // node.connections[socket.id] = socket // store the connection for later use
            uiShared.connections[socket.id] = socket // store the connection for later use

            emitConfig(socket)

            // clean up then re-register listeners
            // cleanupEventHandlers(socket)
            // setup connections, and fire any 'on('connection')' events
            setupEventHandlers(socket, true)
        }
        /**
         * Handles a widget-action event from the UI
         * @param {Socket} conn - socket.io socket connecting to the server
         * @param {String} id - widget id sending the action
         * @param {*} msg - The node-red msg object to forward
         * @returns void
         */
        async function onAction (conn, id, msg) {
            // Hooks API - onAction(conn, id, msg)
            RED.plugins.getByType('node-red-dashboard-2').forEach(plugin => {
                if (plugin.hooks?.onAction && msg) {
                    msg = plugin.hooks.onAction(conn, id, msg)
                }
            })

            if (!msg) {
                // a plugin has made msg blank - meaning that we don't want to send it on
                return
            }

            msg = addConnectionCredentials(RED, msg, conn, n)

            // ensure msg is an object. Assume the incoming data is the payload if not
            if (!msg || typeof msg !== 'object') {
                msg = { payload: msg }
            }

            // get widget node and configuration
            const { wNode, widgetConfig, widgetEvents } = getWidgetAndConfig(id)

            // ensure we can get the requested widget from the runtime & that this widget has an onAction handler
            if (!wNode || !widgetEvents.onAction) {
                return // widget does not exist (e.g. deleted from NR and deployed BUT the ui page was not refreshed)
            }

            // Wrap execution in a try/catch to ensure we don't crash Node-RED
            try {
                msg = await appendTopic(RED, widgetConfig, wNode, msg)

                // pre-process the msg before send on the msg (if beforeSend is defined)
                if (widgetEvents?.beforeSend && typeof widgetEvents.beforeSend === 'function') {
                    msg = await widgetEvents.beforeSend(msg)
                }

                // send the msg onwards
                wNode.send(msg)
            } catch (error) {
                let errorHandler = typeof (widgetEvents.onError) === 'function' ? widgetEvents.onError : null
                errorHandler = errorHandler || (typeof wNode.error === 'function' ? wNode.error : node.error)
                errorHandler && errorHandler(error)
            }
        }

        /**
         * Handles a widget-change event from the UI
         * @param {Socket} conn - socket.io socket connecting to the server
         * @param {String} id - widget id sending the action
         * @param {*} value - The value to send to node-red. Typically this is the payload
         * @returns void
         */
        async function onChange (conn, id, value) {
            // console.log('conn:' + conn.id, 'on:widget-change:' + id, value)

            // get widget node and configuration
            const { wNode, widgetConfig, widgetEvents } = getWidgetAndConfig(id)

            if (!wNode) {
                return // widget does not exist any more (e.g. deleted from NR and deployed BUT the ui page was not refreshed)
            }
            let msg = datastore.get(id) || {}

            RED.plugins.getByType('node-red-dashboard-2').forEach(plugin => {
                if (plugin.hooks?.onChange) {
                    msg = plugin.hooks.onChange(conn, id, msg)
                }
            })

            if (!msg) {
                // a plugin has made msg blank - meaning that we don't want to send it on
                return
            }

            msg = addConnectionCredentials(RED, msg, conn, n)

            async function defaultHandler (msg, value) {
                if (typeof (value) === 'object' && value !== null && hasProperty(value, 'payload')) {
                    msg.payload = value.payload
                } else {
                    msg.payload = value
                }

                msg = await appendTopic(RED, widgetConfig, wNode, msg)

                if (widgetEvents?.beforeSend) {
                    msg = await widgetEvents.beforeSend(msg)
                }
                datastore.save(n, wNode, msg)
                wNode.send(msg) // send the msg onwards
            }

            // wrap execution in a try/catch to ensure we don't crash Node-RED
            try {
                // Most of the time, we can just use this default handler,
                // but sometimes a node needs to do something specific (e.g. ui-switch)
                const handler = typeof (widgetEvents.onChange) === 'function' ? widgetEvents.onChange : defaultHandler
                await handler(msg, value)
            } catch (error) {
                console.log(error)
                let errorHandler = typeof (widgetEvents.onError) === 'function' ? widgetEvents.onError : null
                errorHandler = errorHandler || (typeof wNode.error === 'function' ? wNode.error : node.error)
                errorHandler && errorHandler(error)
            }
        }

        /**
         * Handles a widget-send event from the UI
         * This takes a msg input, and emits it from the relevant node (normally a template node)
         * also stores in the data store, and does not consider any previously stored messages (unlike widget-change)
         * @param {Socket} conn - socket.io socket connecting to the server
         * @param {String} id - widget id sending the action
         * @param {*} msg - The value to send to node-red. Typically this is the payload
         * @returns void
         */
        async function onSend (conn, id, msg) {
            // console.log('conn:' + conn.id, 'on:widget-send:' + id, msg)

            // get widget node and configuration
            const { wNode, widgetEvents } = getWidgetAndConfig(id)

            if (!wNode) {
                return // widget does not exist any more (e.g. deleted from NR and deployed BUT the ui page was not refreshed)
            }

            RED.plugins.getByType('node-red-dashboard-2').forEach(plugin => {
                if (plugin.hooks?.onSend) {
                    msg = plugin.hooks.onSend(conn, id, msg)
                }
            })

            if (!msg) {
                // a plugin has made msg blank - meaning that we don't want to send it on
                return
            }

            msg = addConnectionCredentials(RED, msg, conn, n)

            async function defaultHandler (value) {
                if (widgetEvents?.beforeSend) {
                    msg = await widgetEvents.beforeSend(msg)
                }
                datastore.save(n, wNode, msg)
                wNode.send(msg) // send the msg onwards
            }

            // wrap execution in a try/catch to ensure we don't crash Node-RED
            try {
                // Most of the time, we can just use this default handler,
                // but sometimes a node needs to do something specific (e.g. ui-switch)
                const handler = typeof (widgetEvents.onSend) === 'function' ? widgetEvents.onSend : defaultHandler
                await handler(msg)
            } catch (error) {
                console.log(error)
                let errorHandler = typeof (widgetEvents.onError) === 'function' ? widgetEvents.onError : null
                errorHandler = errorHandler || (typeof wNode.error === 'function' ? wNode.error : node.error)
                errorHandler && errorHandler(error)
            }
        }

        async function onLoad (conn, id, msg) {
            // console.log('conn:' + conn.id, 'on:widget-load:' + id, msg)

            if (!id) {
                console.error('No widget id provided for widget-load event')
                return
            }

            const { wNode, widgetEvents } = getWidgetAndConfig(id)
            // any widgets we hard-code into our front end (e.g ui-notification for connection alerts) will start with ui-
            // Node-RED built nodes will be a random UUID
            if (!wNode && !id.startsWith('ui-')) {
                console.log('widget does not exist any more')
                return // widget does not exist any more (e.g. deleted from NR and deployed BUT the ui page was not refreshed)
            }
            async function handler () {
                let msg = datastore.get(id)
                RED.plugins.getByType('node-red-dashboard-2').forEach(plugin => {
                    if (plugin.hooks?.onLoad) {
                        msg = plugin.hooks.onLoad(conn, id, msg)
                    }
                })

                if (!msg) {
                    // a plugin has made msg blank - meaning that we do anything else
                    return
                }

                conn.emit('widget-load:' + id, msg)
            }
            // wrap execution in a try/catch to ensure we don't crash Node-RED
            try {
                handler()
            } catch (error) {
                let errorHandler = typeof (widgetEvents.onError) === 'function' ? widgetEvents.onError : null
                errorHandler = errorHandler || (typeof wNode.error === 'function' ? wNode.error : node.error)
                errorHandler && errorHandler(error)
            }
        }

        /**
         * Get the widget node and associated configuration/event hooks
         * @param {String} id - ID of the widget
         * @returns {Object} - { wNode, widgetConfig, widgetEvents, widget }
         */
        function getWidgetAndConfig (id) {
            // node.ui?.widgets is empty?
            // themes, groups, etc. are not empty?
            const wNode = RED.nodes.getNode(id)
            const widget = node.ui?.widgets?.get(id)
            const widgetConfig = widget?.props || {}
            const widgetEvents = widget?.hooks || {}
            return { wNode, widgetConfig, widgetEvents, widget }
        }

        // When a UI connects - send the UI Config from Node-RED to the UI
        uiShared.ioServer.on('connection', onConnection)

        // Make sure we clean up after ourselves
        node.on('close', (removed, done) => {
            uiShared.ioServer?.off('connection', onConnection)
            for (const conn of Object.values(uiShared.connections)) {
                cleanupEventHandlers(conn)
            }
            close(node, function (err) {
                if (err) {
                    node.error(`Error closing socket.io server for ${node.id}`, err)
                }
                done()
            })
        })

        /**
         * External Functions for managing UI Components
         */
        // store ui config to be sent to UI
        node.ui = {
            heads: new Map(),
            dashboards: new Map(),
            pages: new Map(),
            themes: new Map(),
            groups: new Map(),
            widgets: new Map()
        }

        node.stores = {
            data: datastore,
            state: statestore
        }

        /**
         * Queue up a config emit to the UI. This is a debounced function
         * NOTES:
         * * only sockets connected to this node will receive the config
         * * each ui-node will have it's own connections and will emit it's own config
         * @returns {void}
         */
        node.requestEmitConfig = function () {
            if (node.emitConfigRequested) {
                return
            }
            node.emitConfigRequested = setTimeout(() => {
                try {
                    // emit config to all connected UI for this ui-base
                    Object.values(uiShared.connections).forEach(socket => {
                        emitConfig(socket)
                    })
                } finally {
                    node.emitConfigRequested = null
                }
            }, 300)
        }

        /**
         * Allow for any child node to emit to all connected UIs
         */
        node.emit = emit

        node.getBaseURL = function () {
            // get the endpoint for the ui-base
            const path = n.path || ''
            // get our HTTP root, defined by NR Settings
            const base = RED.settings.httpNodeRoot || '/'
            const basePart = base.endsWith('/') ? base : `${base}/`
            const dashPart = path.startsWith('/') ? path.slice(1) : path
            const fullPath = `${basePart}${dashPart}`
            return fullPath
        }

        node.registerTheme = function (theme) {
            const { _wireCount, _inputCallback, _inputCallbacks, _closeCallbacks, wires, type, ...t } = theme
            node.ui.themes.set(t.id, t)
        }

        /**
         * Register allows for pages, widgets, groups, etc. to register themselves with the Base UI Node
         * @param {*} page
         * @param {*} widget
         */
        node.register = function (page, group, widgetNode, widgetConfig, widgetEvents) {
            // console.log('dashboard 2.0, UIBaseNode: node.register(...)', page, group, widgetNode, widgetConfig, widgetEvents)
            /**
             * Build UI Config
             */

            // strip widgetConfig of stuff we don't really care about (e.g. Node-RED x/y coordinates)
            // and leave us just with the properties set inside the Node-RED Editor, store as "props"
            // store our UI state properties under the .state key too

            let widget = null

            if (widgetNode && widgetConfig) {
                // default states
                if (statestore.getProperty(widgetConfig.id, 'enabled') === undefined) {
                    statestore.set(n, widgetConfig, null, 'enabled', true)
                }
                if (statestore.getProperty(widgetConfig.id, 'visible') === undefined) {
                    statestore.set(n, widgetConfig, null, 'visible', true)
                }
                if (statestore.getProperty(widgetConfig.id, 'class') === undefined) {
                    statestore.set(n, widgetConfig, null, 'class', '')
                }

                // build widget object
                widget = {
                    id: widgetConfig.id,
                    type: widgetConfig.type,
                    props: widgetConfig,
                    layout: {
                        width: widgetConfig.width || 3,
                        height: widgetConfig.height || 1,
                        order: widgetConfig.order || 0
                    },
                    state: statestore.getAll(widgetConfig.id),
                    hooks: widgetEvents,
                    src: uiShared.contribs[widgetConfig.type]
                }
                const parent = RED.nodes.getNode(widgetConfig.z)
                if (parent && parent.TYPE === 'subflow') {
                    const orderEnv = parent.subflowInstance.env?.find(e => e.key === 'DB2_SF_ORDER')
                    let order = parseInt(orderEnv?.value)
                    if (isNaN(order)) {
                        order = 0
                    }
                    widget.props.subflow = {
                        id: widgetConfig.z,
                        name: parent.subflowInstance?.name || parent.subflowDef.name,
                        order
                    }
                }

                delete widget.props.id
                delete widget.props.type
                delete widget.props.x
                delete widget.props.y
                delete widget.props.wires

                if (widget.props.width === '0') {
                    widget.props.width = null
                }
                if (widget.props.height === '0') {
                    widget.props.height = null
                }

                // merge the statestore with our props toa ccount for dynamically set properties:

                // loop over props and check if we have any function definitions (e.g. onMounted, onInput)
                // and stringify them for transport over SocketIO
                for (const [key, value] of Object.entries(widget.props)) {
                    // supported functions
                    const supported = ['onMounted', 'onInput']
                    if (supported.includes(key) && typeof value === 'function') {
                        widget.props[key] = value.toString()
                    } else if (key === 'methods') {
                        for (const [method, fcn] of Object.entries(widget.props.methods)) {
                            if (typeof fcn === 'function') {
                                widget.props.methods[method] = fcn.toString()
                            }
                        }
                    }
                }
            }

            // map dashboards by their ID
            if (!node.ui.dashboards.has(n.id)) {
                node.ui.dashboards.set(n.id, n)
            }

            // map themes by their ID
            if (page && page.type === 'ui-page' && !node.ui.themes.has(page.theme)) {
                const theme = RED.nodes.getNode(page.theme)
                if (theme) {
                    node.registerTheme(theme)
                } else {
                    node.warn(`Theme '${page.theme}' specified  in page '${page.id}' does not exist`)
                }
            }

            // map pages by their ID
            if (page) {
                // ensure we have the latest instance of the page's node
                const { _users, ...p } = page
                node.ui.pages.set(page.id, p)
            }

            // map groups on a page-by-page basis
            if (group) {
                const { _user, type, ...g } = group
                node.ui.groups.set(group.id, g)
            }

            // map widgets on a group-by-group basis
            if (widgetNode && widgetConfig && !node.ui.widgets.has(widget.id)) {
                node.ui.widgets.set(widget.id, widget)
            }

            /**
             * Helper Function for testing
             */

            if (widgetNode) {
                widgetNode.getState = function () {
                    return datastore.get(widgetNode.id)
                }

                /**
                 * Event Handlers
                 */

                // add Node-RED listener to the widget for when it's corresponding node receives a msg in Node-RED
                widgetNode?.on('input', async function (msg, send, done) {
                    // clean msg - #668
                    delete msg.res
                    delete msg.req

                    // ensure we have latest instance of the widget's node
                    const wNode = RED.nodes.getNode(widgetNode.id)
                    if (!wNode) {
                        return // widget does not exist any more (e.g. deleted from NR and deployed BUT the ui page was not refreshed)
                    }

                    // Hooks API - onInput(msg)
                    RED.plugins.getByType('node-red-dashboard-2').forEach(plugin => {
                        if (plugin.hooks?.onInput) {
                            msg = plugin.hooks.onInput(msg)
                        }
                    })

                    if (!msg) {
                        // a plugin has made msg blank - meaning that we do anything else
                        return
                    }

                    try {
                        // pre-process the msg before running our onInput function
                        if (widgetEvents?.beforeSend) {
                            msg = await widgetEvents.beforeSend(msg)
                        }

                        // standard dynamic property handlers
                        if (hasProperty(msg, 'enabled')) {
                            statestore.set(n, widgetNode, msg, 'enabled', msg.enabled)
                        }
                        if (hasProperty(msg, 'visible')) {
                            statestore.set(n, widgetNode, msg, 'visible', msg.visible)
                        }
                        if (hasProperty(msg, 'class') || (hasProperty(msg, 'ui_update') && hasProperty(msg.ui_update, 'class'))) {
                            const cls = msg.class || msg.ui_update?.class
                            statestore.set(n, widgetNode, msg, 'class', cls)
                        }

                        // run any node-specific handler defined in the Widget's component
                        if (widgetEvents?.onInput) {
                            await widgetEvents?.onInput(msg, send)
                        } else {
                            // msg could be null if the beforeSend errors and returns null
                            if (msg) {
                                // store the latest msg passed to node
                                datastore.save(n, widgetNode, msg)

                                if (widgetConfig.topic || widgetConfig.topicType) {
                                    msg = await appendTopic(RED, widgetConfig, wNode, msg)
                                }
                                if (hasProperty(widgetConfig, 'passthru')) {
                                    if (widgetConfig.passthru) {
                                        send(msg)
                                    }
                                } else {
                                    send(msg)
                                }
                            }
                        }

                        // emit to all connected UIs
                        emit('msg-input:' + widget.id, msg, wNode)

                        done()
                    } catch (err) {
                        if (err.type === 'warn') {
                            wNode.warn(err.message)
                            done()
                        } else {
                            done(err)
                        }
                    }
                })

                // when a widget is "closed" remove it from this Base Node's knowledge
                widgetNode?.on('close', function (removed, done) {
                    if (removed) {
                        // widget has been removed from the Editor
                        // clear any data from datastore
                        datastore.clear(widgetNode.id)
                    }
                    node.deregister(null, null, widgetNode)
                    done()
                })
            }
            node.requestEmitConfig() // queue up a config emit to the UI
        }

        node.deregister = function (page, group, widgetNode) {
            let changes = false
            // remove widget from our UI config
            if (widgetNode) {
                const widget = node.ui.widgets.get(widgetNode.id)
                if (widget.hooks?.onSocket) {
                    // We have some custom socketIO hooks to remove

                    // loop over SocketIO connections
                    for (const socket of Object.values(uiShared.connections)) {
                        // loop over events
                        for (const [eventName] of Object.entries(widget.hooks.onSocket)) {
                            // remove the listener for this event
                            if (widget._onSocketHandlers) {
                                socket.off(eventName, widget._onSocketHandlers[eventName])
                            }
                        }
                    }
                }
                node.ui.widgets.delete(widgetNode.id)
                changes = true
            }

            // if there are no more widgets on this group, remove the group from our UI config
            if (group && [...node.ui.widgets].filter(w => w.props?.group === group.id).length === 0) {
                node.ui.groups.delete(group.id)
                changes = true
            }

            // if there are no more groups on this page, remove the page from our UI config
            if (page && [...node.ui.groups].filter(g => g.page === page.id).length === 0) {
                node.ui.pages.delete(page.id)
                changes = true
            }
            if (changes) {
                node.requestEmitConfig()
            }
        }

        // Finally, queue up a config emit to the UI.
        // NOTE: this is a cautionary measure only - typically the registration of nodes will queue up a config emit
        // but in cases where the dashboard has no widgets registered, we still need to emit a config
        node.requestEmitConfig()
    }

    RED.nodes.registerType('ui-base', UIBaseNode)
}
