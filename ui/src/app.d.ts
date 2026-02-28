// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	namespace svelteHTML {
		interface HTMLAttributes<T> {
			'hx-get'?: string;
			'hx-post'?: string;
			'hx-put'?: string;
			'hx-delete'?: string;
			'hx-trigger'?: string;
			'hx-target'?: string;
			'hx-swap'?: string;
			'hx-vals'?: string;
			'hx-include'?: string;
			'hx-headers'?: string;
			'hx-confirm'?: string;
		}
	}
}

export {};
