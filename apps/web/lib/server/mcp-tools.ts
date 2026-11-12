import {createMcpHandler, McpServer} from '@modelcontextprotocol/server';
import {z} from 'zod';
import {
  isQuestionInput,
  questionInput,
  validQuestionCursor,
} from '../questions';
import {roomIdPattern, secretPattern} from '../rooms';
import {validCursor} from '../voting-links';
import {uploadAsset} from './asset-proxy';
import {
  bearer,
  boundedBody,
  mcpBackend,
  mcpHeaders,
  publicOrigin,
} from './mcp-backend';

const maxJson = 3 * 1024 * 1024;
// Leave room for base64 overhead under the production proxy limit
const maxInlineBytes = 8 * 1024 * 1024;
const maxBase64 = 4 * Math.ceil(maxInlineBytes / 3);
const uuid = z.string().regex(roomIdPattern);
const question = z.object({
  content: z.string().max(20000).describe('Question text in Markdown'),
  choices: z
    .array(
      z.object({
        id: uuid
          .optional()
          .describe('Keep this ID when updating an existing option'),
        content: z.string().max(5000),
        capacity: z.number().int().min(1).max(1000000).optional(),
      }),
    )
    .max(100),
  questionType: z.enum(['choice', 'allocation']).optional(),
  choiceMode: z.enum(['single', 'multiple']),
  minChoices: z.number().int().min(0).max(100),
  maxChoices: z.number().int().min(1).max(100),
  shareResults: z.boolean(),
  publication: z.enum(['after_answer', 'after_close']),
  hideResultsUntilEnd: z.boolean(),
  allowAnswerChange: z.boolean(),
  anonymous: z.boolean(),
  allowSkip: z.boolean().optional(),
  hideUntilOpen: z.boolean().optional(),
  hideUnavailable: z.boolean().optional(),
  closeWhenAllAnswered: z.boolean().optional(),
  expectedLinkIds: z.array(uuid).max(100).optional(),
});

const tools = {
  questions_list: {
    description:
      'List questions in the connected room, including drafts and their IDs',
    schema: z.object({
      after: z.string().refine(validQuestionCursor).optional(),
    }),
    readOnly: true,
  },
  questions_get: {
    description:
      'Read a question with all options, settings and its current revision',
    schema: z.object({id: uuid}),
    readOnly: true,
  },
  questions_create_batch: {
    description:
      'Create 1 to 20 draft questions atomically. Reuse requestId only to retry the same batch. Use asset:<id> references for uploaded images',
    schema: z.object({
      requestId: uuid,
      questions: z.array(question).min(1).max(20),
    }),
    readOnly: false,
  },
  questions_update: {
    description:
      'Save the full editor document with the latest revision and existing option IDs. The question state stays under room control',
    schema: z.object({
      id: uuid,
      revision: z.string().refine(validCursor),
      question,
    }),
    readOnly: false,
  },
  results_list: {
    description:
      'List question results and their availability, up to 50 per page',
    schema: z.object({after: z.string().refine(validCursor).optional()}),
    readOnly: true,
  },
  results_get: {
    description:
      'Read question totals and option IDs. Named answers are available only for non-anonymous questions. Use nextPeopleCursor for another page',
    schema: z.object({questionId: uuid, peopleAfter: uuid.optional()}),
    readOnly: true,
  },
  results_summary: {
    description:
      'Read the room summary with question totals and answer sources',
    schema: z.object({}),
    readOnly: true,
  },
  registration_groups_list: {
    description: 'Find registration groups by name and ID, up to 50 per page',
    schema: z.object({after: z.string().refine(validCursor).optional()}),
    readOnly: true,
  },
  registration_members_list: {
    description:
      'List registered or pending members in a group. Keep the member IDs and revisions to edit names or moderate entry',
    schema: z.object({
      groupId: uuid,
      filter: z.enum(['registered', 'pending']).optional(),
      after: z.string().refine(validCursor).optional(),
    }),
    readOnly: true,
  },
  registration_member_rename: {
    description:
      'Set the name of a registered member using the latest revision',
    schema: z.object({
      groupId: uuid,
      memberId: uuid,
      revision: z.string().refine(validCursor),
      name: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .refine((value) => !value.includes('\0')),
    }),
    readOnly: false,
  },
  registration_member_moderate: {
    description:
      'Approve or reject a registration, block or unblock a member, or send an attendance call. Use the latest member revision',
    schema: z.object({
      groupId: uuid,
      memberId: uuid,
      revision: z.string().refine(validCursor),
      action: z.enum(['approve', 'reject', 'block', 'unblock', 'call']),
    }),
    readOnly: false,
  },
  registration_results: {
    description:
      'Read named answers for one registration group and one question, up to 50 per page. Anonymous and hidden results cannot be filtered by group. Use results_get to match option IDs to their text',
    schema: z.object({groupId: uuid, questionId: uuid, after: uuid.optional()}),
    readOnly: true,
  },
  media_upload: {
    description:
      'Upload image bytes as base64, up to 8 MiB before encoding. Returns an asset:<id> for Markdown. The HTTP API also accepts a multipart file',
    schema: z.object({
      name: z.string().min(1).max(200),
      mime: z.string().regex(/^image\/[a-z0-9.+-]+$/),
      base64: z.string().min(4).max(maxBase64),
    }),
    readOnly: false,
  },
} as const;
type ToolName = keyof typeof tools;

interface Agent {
  // Only this room can be selected with the credential
  room: string;
  token: string;
}

// Reply with a short machine-readable error
function error(status: number, code: string) {
  return Response.json({error: code}, {status, headers: mcpHeaders});
}

// Reject cross-site browser calls and allow native clients without an Origin
function allowedOrigin(request: Request) {
  const origin = request.headers.get('origin');
  return (
    request.headers.get('sec-fetch-site') !== 'cross-site' &&
    (!origin || origin === publicOrigin(request))
  );
}

// Resolve the room from the token before calling any private operation
async function agentAccess(
  room: string,
  token: string | null,
): Promise<Agent | Response> {
  if (room && !roomIdPattern.test(room)) return error(404, 'missing');
  if (!token || !secretPattern.test(token)) return error(401, 'invalid_token');
  const result = await mcpBackend('operation', room, token, 'access');
  if (result.status === 401) return error(401, 'invalid_token');
  if (!result.ok) return error(503, 'unavailable');
  const {room: resolved} = await result.json();
  if (typeof resolved !== 'string' || !roomIdPattern.test(resolved))
    return error(503, 'unavailable');
  return {room: resolved, token};
}

// Turn inline image bytes into the same form used by the editor
function imageRequest(name: string, mime: string, base64: string) {
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
    return null;
  const bytes = Buffer.from(base64, 'base64');
  if (
    !bytes.length ||
    bytes.length > maxInlineBytes ||
    bytes.toString('base64') !== base64
  )
    return null;
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], name, {type: mime}));
  return new Request('http://localhost/upload', {method: 'POST', body: form});
}

// Share the same tool contract between MCP and ordinary HTTP callers
async function callTool(agent: Agent, name: ToolName, input: unknown) {
  const parsed = tools[name].schema.safeParse(input);
  if (!parsed.success) return error(400, 'invalid_arguments');
  let data: Record<string, unknown> = parsed.data;
  if (name === 'media_upload') {
    const {
      name: filename,
      mime,
      base64,
    } = data as z.infer<typeof tools.media_upload.schema>;
    const request = imageRequest(filename, mime, base64);
    return request
      ? uploadAsset(request, agent.room, agent)
      : error(400, 'invalid_image');
  }
  if (name === 'questions_list') data = {after: data.after ?? '0'};
  if (name === 'questions_create_batch') {
    const documents = data.questions as unknown[];
    for (const [index, document] of documents.entries()) {
      if (
        !isQuestionInput(document) ||
        document.choices.some((choice) => choice.id)
      )
        return Response.json(
          {error: 'invalid_question', index},
          {status: 400, headers: mcpHeaders},
        );
    }
    data = {
      ...data,
      questions: documents.filter(isQuestionInput).map(questionInput),
    };
  }
  if (name === 'questions_update') {
    if (!isQuestionInput(data.question)) return error(400, 'invalid_question');
    data = {...data, question: questionInput(data.question)};
  }
  if (Buffer.byteLength(JSON.stringify(data)) > maxJson)
    return error(413, 'too_large');
  const response = await mcpBackend(
    'operation',
    agent.room,
    agent.token,
    name,
    data,
  );
  const result = await response.json();
  return Response.json(result, {status: response.status, headers: mcpHeaders});
}

// List tools publicly and check the token only when a tool is called
function buildServer(headerToken: string | null) {
  const server = new McpServer({
    name: 'vote.machine',
    version: '1.0.0',
  });
  for (const name of Object.keys(tools) as ToolName[]) {
    const tool = tools[name];
    server.registerTool<z.ZodType, z.ZodType>(
      name,
      {
        description: tool.description,
        inputSchema: tool.schema.extend({
          apiToken: z
            .string()
            .optional()
            .describe(
              'Room API token from Settings > MCP and API, required unless sent in the Authorization header',
            ),
        }),
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint:
            !tool.readOnly &&
            name !== 'questions_create_batch' &&
            name !== 'media_upload',
          openWorldHint: false,
          idempotentHint: tool.readOnly || name === 'questions_create_batch',
        },
      },
      async (args) => {
        try {
          const {apiToken, ...input} = args as {apiToken?: string};
          // Do not forward the credential as part of the tool document
          const access =
            headerToken && apiToken && headerToken !== apiToken
              ? error(401, 'invalid_token')
              : await agentAccess('', headerToken ?? apiToken ?? null);
          const reply =
            access instanceof Response
              ? access
              : await callTool(access, name, input);
          const result = await reply.json();
          return {
            content: [{type: 'text', text: JSON.stringify(result)}],
            structuredContent: result,
            isError: !reply.ok,
          };
        } catch {
          return {
            content: [{type: 'text', text: 'Service unavailable'}],
            isError: true,
          };
        }
      },
    );
  }
  return server;
}

// Use the official SDK for current and legacy Streamable HTTP clients
export async function serveMcp(request: Request) {
  try {
    if (!allowedOrigin(request)) return error(403, 'origin_denied');
    const body =
      request.method === 'POST'
        ? await boundedBody(request, maxBase64 + maxJson)
        : null;
    const bounded = body
      ? new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: new Uint8Array(body),
          signal: request.signal,
        })
      : request;
    const response = await createMcpHandler(() =>
      buildServer(bearer(request)),
    ).fetch(bounded);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(mcpHeaders))
      headers.set(key, value);
    return new Response(response.body, {status: response.status, headers});
  } catch (failure) {
    return failure instanceof RangeError
      ? error(413, 'too_large')
      : error(503, 'unavailable');
  }
}

// Offer the same room operations over the HTTP API
export async function serveAgentApi(
  request: Request,
  room: string,
  name: string,
) {
  if (!Object.hasOwn(tools, name)) return error(404, 'missing');
  try {
    if (!allowedOrigin(request)) return error(403, 'origin_denied');
    const agent = await agentAccess(room, bearer(request));
    if (agent instanceof Response) return agent;
    if (
      name === 'media_upload' &&
      request.headers.get('content-type')?.startsWith('multipart/form-data;')
    )
      return uploadAsset(request, agent.room, agent);
    if (
      request.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      return error(415, 'invalid_content_type');
    const body = await boundedBody(
      request,
      name === 'media_upload' ? maxBase64 + 4096 : maxJson,
    );
    return await callTool(agent, name as ToolName, JSON.parse(body.toString()));
  } catch (failure) {
    if (failure instanceof RangeError) return error(413, 'too_large');
    if (failure instanceof SyntaxError) return error(400, 'invalid_json');
    return error(503, 'unavailable');
  }
}
