import { z } from 'zod';

export const UiToneSchema = z.enum(['neutral', 'success', 'warning', 'danger']);
export type UiTone = z.infer<typeof UiToneSchema>;

/* ─── Shared item schemas ─── */

const StatItemSchema = z.object({
	label: z.string().min(1),
	value: z.string().min(1),
	detail: z.string().optional(),
	tone: UiToneSchema.optional()
});

const KeyValueItemSchema = z.object({
	key: z.string().min(1),
	value: z.string(),
	tone: UiToneSchema.optional()
});

const ActionItemSchema = z.object({
	label: z.string().min(1),
	href: z.string().min(1),
	description: z.string().optional(),
	method: z.enum(['GET', 'POST']).default('GET'),
	tone: UiToneSchema.optional()
});

const FormOptionSchema = z.object({
	label: z.string().min(1),
	value: z.string().min(1)
});

const FormFieldSchema = z.object({
	name: z.string().min(1),
	label: z.string().min(1),
	kind: z
		.enum([
			'text',
			'textarea',
			'password',
			'email',
			'number',
			'select',
			'checkbox',
			'toggle',
			'range',
			'date',
			'radio',
			'tags',
			'file',
			'color'
		])
		.default('text'),
	placeholder: z.string().optional(),
	required: z.boolean().default(false),
	options: z.array(FormOptionSchema).default([]),
	defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
	help: z.string().optional(),
	min: z.number().optional(),
	max: z.number().optional(),
	step: z.number().optional(),
	accept: z.string().optional(),
	disabled: z.boolean().optional()
});

/* ─── Original block schemas (backward-compatible) ─── */

const NoticeBlockSchema = z.object({
	type: z.literal('notice'),
	tone: UiToneSchema.default('neutral'),
	message: z.string().min(1),
	detail: z.string().optional()
});

const StatsBlockSchema = z.object({
	type: z.literal('stats'),
	items: z.array(StatItemSchema).min(1)
});

const KeyValuesBlockSchema = z.object({
	type: z.literal('key_values'),
	items: z.array(KeyValueItemSchema).min(1)
});

const TableBlockSchema = z.object({
	type: z.literal('table'),
	columns: z.array(z.string().min(1)).min(1),
	rows: z.array(z.record(z.string(), z.string())).default([])
});

const ActionsBlockSchema = z.object({
	type: z.literal('actions'),
	items: z.array(ActionItemSchema).min(1)
});

const FormBlockSchema = z.object({
	type: z.literal('form'),
	id: z.string().min(1),
	title: z.string().optional(),
	description: z.string().optional(),
	submit: z.object({
		href: z.string().min(1),
		method: z.enum(['GET', 'POST']).default('POST')
	}),
	submitLabel: z.string().default('Submit'),
	fields: z.array(FormFieldSchema).min(1)
});

const CodeBlockSchema = z.object({
	type: z.literal('code'),
	title: z.string().optional(),
	language: z.string().default('text'),
	code: z.string().min(1)
});

/* ─── New block schemas ─── */

const DividerBlockSchema = z.object({
	type: z.literal('divider'),
	label: z.string().optional()
});

const HeroBlockSchema = z.object({
	type: z.literal('hero'),
	title: z.string().min(1),
	subtitle: z.string().optional(),
	image: z.string().optional(),
	actions: z.array(ActionItemSchema).default([]),
	tone: UiToneSchema.optional()
});

const MarkdownBlockSchema = z.object({
	type: z.literal('markdown'),
	content: z.string().min(1)
});

const MediaBlockSchema = z.object({
	type: z.literal('media'),
	kind: z.enum(['image', 'video', 'iframe']).default('image'),
	src: z.string().min(1),
	alt: z.string().optional(),
	caption: z.string().optional(),
	width: z.number().optional(),
	height: z.number().optional()
});

const TimelineEventSchema = z.object({
	title: z.string().min(1),
	description: z.string().optional(),
	timestamp: z.string().optional(),
	tone: UiToneSchema.optional()
});

const TimelineBlockSchema = z.object({
	type: z.literal('timeline'),
	events: z.array(TimelineEventSchema).min(1)
});

const ChatMessageSchema = z.object({
	role: z.enum(['user', 'assistant', 'system']),
	content: z.string().min(1),
	timestamp: z.string().optional(),
	name: z.string().optional()
});

const ChatMessagesBlockSchema = z.object({
	type: z.literal('chat_messages'),
	messages: z.array(ChatMessageSchema).min(1)
});

const EmptyStateBlockSchema = z.object({
	type: z.literal('empty_state'),
	title: z.string().min(1),
	detail: z.string().optional(),
	actionLabel: z.string().optional(),
	actionHref: z.string().optional()
});

const MetricCardSchema = z.object({
	label: z.string().min(1),
	value: z.string().min(1),
	change: z.string().optional(),
	trend: z.enum(['up', 'down', 'flat']).optional(),
	tone: UiToneSchema.optional()
});

const MetricCardsBlockSchema = z.object({
	type: z.literal('metric_cards'),
	items: z.array(MetricCardSchema).min(1)
});

const ProgressItemSchema = z.object({
	label: z.string().min(1),
	value: z.number(),
	max: z.number().default(100),
	tone: UiToneSchema.optional()
});

const ProgressBlockSchema = z.object({
	type: z.literal('progress'),
	items: z.array(ProgressItemSchema).min(1)
});

const StepperStepSchema = z.object({
	label: z.string().min(1),
	description: z.string().optional(),
	status: z.enum(['pending', 'active', 'completed']).default('pending')
});

const StepperBlockSchema = z.object({
	type: z.literal('stepper'),
	steps: z.array(StepperStepSchema).min(1)
});

const CalloutBlockSchema = z.object({
	type: z.literal('callout'),
	tone: z.enum(['info', 'tip', 'warning', 'danger']).default('info'),
	title: z.string().optional(),
	message: z.string().min(1)
});

/* ─── Combined block schema ─── */

// Non-recursive blocks use discriminatedUnion for better error messages
const BaseUiBlockSchema = z.discriminatedUnion('type', [
	NoticeBlockSchema,
	StatsBlockSchema,
	KeyValuesBlockSchema,
	TableBlockSchema,
	ActionsBlockSchema,
	FormBlockSchema,
	CodeBlockSchema,
	DividerBlockSchema,
	HeroBlockSchema,
	MarkdownBlockSchema,
	MediaBlockSchema,
	TimelineBlockSchema,
	ChatMessagesBlockSchema,
	EmptyStateBlockSchema,
	MetricCardsBlockSchema,
	ProgressBlockSchema,
	StepperBlockSchema,
	CalloutBlockSchema
]);

// UiBlock type -- includes both base and recursive block types
export type UiBlock =
	| z.infer<typeof BaseUiBlockSchema>
	| { type: 'tabs'; tabs: { id: string; label: string; blocks: UiBlock[] }[] }
	| { type: 'accordion'; items: { id: string; title: string; blocks: UiBlock[] }[] }
	| { type: 'columns'; count: number; columns: { blocks: UiBlock[] }[] };

// Recursive block schemas using z.lazy for child blocks
const TabsBlockSchema: z.ZodType<Extract<UiBlock, { type: 'tabs' }>> = z.object({
	type: z.literal('tabs'),
	tabs: z.array(
		z.object({
			id: z.string().min(1),
			label: z.string().min(1),
			blocks: z.lazy((): z.ZodType<UiBlock[]> => z.array(UiBlockSchema).min(1))
		})
	).min(1)
});

const AccordionBlockSchema: z.ZodType<Extract<UiBlock, { type: 'accordion' }>> = z.object({
	type: z.literal('accordion'),
	items: z.array(
		z.object({
			id: z.string().min(1),
			title: z.string().min(1),
			blocks: z.lazy((): z.ZodType<UiBlock[]> => z.array(UiBlockSchema).min(1))
		})
	).min(1)
});

const ColumnsBlockSchema: z.ZodType<Extract<UiBlock, { type: 'columns' }>> = z.object({
	type: z.literal('columns'),
	count: z.number().int().min(1).max(4).default(2),
	columns: z.array(
		z.object({
			blocks: z.lazy((): z.ZodType<UiBlock[]> => z.array(UiBlockSchema).min(1))
		})
	).min(1)
});

// Full UiBlockSchema: base blocks + recursive blocks
export const UiBlockSchema: z.ZodType<UiBlock> = z.union([
	BaseUiBlockSchema,
	TabsBlockSchema,
	AccordionBlockSchema,
	ColumnsBlockSchema
]);

/* ─── Section & Model ─── */

export const UiSectionSchema = z.object({
	id: z.string().min(1),
	title: z.string().min(1),
	description: z.string().optional(),
	blocks: z.array(UiBlockSchema).min(1)
});

export type UiSection = z.infer<typeof UiSectionSchema>;

export const UiModelSchema = z.object({
	id: z.string().min(1),
	title: z.string().min(1),
	subtitle: z.string().optional(),
	refreshedAt: z.string().optional(),
	sections: z.array(UiSectionSchema).min(1)
});

export type UiModel = z.infer<typeof UiModelSchema>;

export function parseUiModel(input: unknown): UiModel {
	return UiModelSchema.parse(input);
}
