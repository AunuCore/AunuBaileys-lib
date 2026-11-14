// AunuBaileys P2b port: faithful TypeScript-tree port of the v6 (1.0.89)
// JavaScript module of the same name — behaviour and HB/version
// annotations preserved verbatim.
/**
 * AunuBaileys: the offline stanza queue. Upstream's inline processor
 * awaited each handler with no per-node guard: one throwing node
 * aborted the whole drain, dropped the rest of the backlog, and left
 * the processor wedged (its busy flag never reset), so every later
 * offline node was silently swallowed for the rest of the session.
 * Here a failing node is reported and the queue moves on; the busy
 * flag always resets; the event loop gets a breath every few nodes.
 * (Failure class also fixed downstream by raiden-baileys.)
 */
export const createOfflineNodeQueue = ({
	onError,
	isOpen = () => true,
	yieldEvery = 10
}: {
	onError?: (err: any, context: string) => void
	isOpen?: () => boolean
	yieldEvery?: number
} = {}) => {
	const handlers = new Map<string, (node: any) => Promise<void> | void>()
	const nodes: { type: string; node: any }[] = []
	let isProcessing = false
	const enqueue = (type: string, node: any) => {
		nodes.push({ type, node })
		if (isProcessing) {
			return
		}
		isProcessing = true
		;(async () => {
			let processed = 0
			try {
				while (nodes.length && isOpen()) {
					const { type: nodeType, node: current } = nodes.shift()!
					const handler = handlers.get(nodeType)
					if (!handler) {
						onError?.(new Error(`unknown offline node type: ${nodeType}`), 'processing offline node')
						continue
					}
					try {
						await handler(current)
					} catch (err) {
						onError?.(err, 'processing offline node')
					}
					processed += 1
					if (yieldEvery > 0 && processed % yieldEvery === 0) {
						await new Promise(resolve => setImmediate(resolve))
					}
				}
			} finally {
				isProcessing = false
			}
		})().catch(err => onError?.(err, 'processing offline nodes'))
	}
	return {
		enqueue,
		register: (type: string, handler: (node: any) => Promise<void> | void) => handlers.set(type, handler),
		get size() {
			return nodes.length
		},
		get processing() {
			return isProcessing
		}
	}
}
