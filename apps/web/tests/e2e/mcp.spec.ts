import {randomBytes, randomUUID} from 'node:crypto';
import {expect, test, type APIRequestContext} from '@playwright/test';
import {votingFixture} from './voting-helpers';

// Read either Streamable HTTP response format
async function rpc(
  api: APIRequestContext,
  resource: string,
  token: string,
  method: string,
  params: object,
  modern = false,
) {
  const response = await api.post(resource, {
    headers: {
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
      Accept: 'application/json, text/event-stream',
      'Mcp-Protocol-Version': modern ? '2026-07-28' : '2025-11-25',
      ...(modern ? {'Mcp-Method': method} : {}),
    },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        ...(modern
          ? {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'Test client',
                  version: '1',
                },
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            }
          : {}),
      },
    },
  });
  const body = await response.text();
  expect(response.status(), body).toBe(200);
  const line = body.split('\n').find((item) => item.startsWith('data: '));
  return JSON.parse(line?.slice(6) ?? body);
}

test('public MCP discovery, shared room token and rotation work across clients', async ({
  page,
  request,
  browser,
}) => {
  const f = await votingFixture(page);
  const path = `/api/rooms/${f.room.id}/mcp`;
  const resource = `${f.origin}/api/mcp`;
  await page.goto(`/rooms/${f.room.id}`);
  await page.getByRole('tab', {name: 'Настройки', exact: true}).click();
  await expect(page.getByLabel('MCP-ссылка', {exact: true})).toHaveValue(
    resource,
  );

  const field = page.getByLabel('API-токен комнаты', {exact: true});
  await expect(field).toHaveAttribute('type', 'password');
  await expect(field).toHaveValue(/^[0-9a-f]{64}$/);
  await page
    .getByRole('button', {name: 'Показать API-токен', exact: true})
    .click();
  await expect(field).toHaveAttribute('type', 'text');
  const token = await field.inputValue();
  expect(
    (await request.post(path, {headers: {Origin: f.origin}})).status(),
  ).toBe(401);
  expect(
    (
      await page.request.put(path, {headers: {Origin: 'https://other.example'}})
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post(resource, {
        headers: {Origin: 'https://other.example'},
        data: {},
      })
    ).status(),
  ).toBe(403);

  const initialized = await rpc(request, resource, '', 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: {name: 'Test client', version: '1'},
  });
  expect(initialized.result.serverInfo.name).toBe('vote.machine');
  const discovery = await rpc(request, resource, '', 'tools/list', {});
  expect(
    discovery.result.tools.map((tool: {name: string}) => tool.name).sort(),
  ).toEqual([
    'media_upload',
    'questions_create_batch',
    'questions_get',
    'questions_list',
    'questions_update',
    'registration_groups_list',
    'registration_member_moderate',
    'registration_member_rename',
    'registration_members_list',
    'registration_results',
    'results_get',
    'results_list',
    'results_summary',
  ]);
  const modern = await rpc(request, resource, '', 'tools/list', {}, true);
  expect(modern.result.tools).toEqual(discovery.result.tools);

  const denied = await rpc(request, resource, '', 'tools/call', {
    name: 'questions_list',
    arguments: {},
  });
  expect(denied.result.isError).toBe(true);
  expect(denied.result.structuredContent).toEqual({error: 'invalid_token'});
  const wrongToken = await rpc(request, resource, '', 'tools/call', {
    name: 'questions_list',
    arguments: {apiToken: randomBytes(32).toString('hex')},
  });
  expect(wrongToken.result.isError).toBe(true);

  const upload = await rpc(request, resource, '', 'tools/call', {
    name: 'media_upload',
    arguments: {
      apiToken: token,
      name: 'question.png',
      mime: 'image/png',
      base64:
        'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMwTptpnDaTAUIBAB/uBMm6iK1UAAAAAElFTkSuQmCC',
    },
  });
  expect(upload.result.isError, JSON.stringify(upload)).toBe(false);
  const source = upload.result.structuredContent.source;
  expect(source).toMatch(/^asset:/);
  const question = {
    content: `Question with image\n\n![Example](${source})`,
    choices: [{content: 'A'}, {content: 'B'}],
    choiceMode: 'single',
    minChoices: 1,
    maxChoices: 1,
    shareResults: false,
    publication: 'after_close',
    hideResultsUntilEnd: false,
    allowAnswerChange: false,
    anonymous: false,
  };
  const batch = {
    requestId: randomUUID(),
    questions: [
      question,
      ...Array.from({length: 9}, (_, i) => ({
        ...question,
        content: `Extra ${i + 1}`,
      })),
    ],
  };
  const create = await rpc(request, resource, token, 'tools/call', {
    name: 'questions_create_batch',
    arguments: batch,
  });
  expect(create.result.isError, JSON.stringify(create)).toBe(false);
  expect(create.result.structuredContent.questions).toHaveLength(10);
  const api = `${f.origin}/api/agent`;
  const headers = {Authorization: `Bearer ${token}`};
  const id = create.result.structuredContent.questions[0].id;
  const get = await request.post(`${api}/questions_get`, {headers, data: {id}});
  expect(get.status()).toBe(200);
  const saved = (await get.json()).question;
  expect(saved.state).toBe('draft');
  const update = {
    id,
    revision: saved.revision,
    question: {...saved, content: 'Edited by the agent'},
  };
  expect(
    (
      await request.post(`${api}/questions_update`, {headers, data: update})
    ).status(),
  ).toBe(200);
  expect(
    (
      await request.post(`${api}/questions_update`, {headers, data: update})
    ).status(),
  ).toBe(409);
  await page.goto(`/rooms/${f.room.id}`);
  await expect(
    page.getByRole('heading', {name: 'Edited by the agent', exact: true}),
  ).toBeVisible();
  await page.getByRole('tab', {name: 'Настройки', exact: true}).click();
  await expect(field).toHaveValue(token);
  const rotate = page.getByRole('button', {
    name: 'Обновить API-токен',
    exact: true,
  });
  await rotate.click();
  await page
    .getByRole('dialog')
    .getByRole('button', {name: 'Отмена', exact: true})
    .click();
  await expect(field).toHaveValue(token);
  await rotate.click();
  await page
    .getByRole('dialog')
    .getByRole('button', {name: 'Обновить API-токен', exact: true})
    .click();
  await expect(field).not.toHaveValue(token);
  await expect(field).toHaveAttribute('type', 'password');
  const replacement = await field.inputValue();
  expect(replacement).toMatch(/^[0-9a-f]{64}$/);

  expect(
    (await request.post(`${api}/questions_list`, {headers, data: {}})).status(),
  ).toBe(401);
  const oldTool = await rpc(request, resource, '', 'tools/call', {
    name: 'questions_list',
    arguments: {apiToken: token},
  });
  expect(oldTool.result.structuredContent).toEqual({error: 'invalid_token'});
  const current = await rpc(request, resource, '', 'tools/call', {
    name: 'questions_get',
    arguments: {apiToken: replacement, id},
  });
  expect(current.result.structuredContent.question.content).toBe(
    'Edited by the agent',
  );
  const nextHeaders = {Authorization: `Bearer ${replacement}`};
  expect(
    (
      await request.post(`${api}/questions_get`, {
        headers: nextHeaders,
        data: {id},
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await request.post(`${api}/${randomUUID()}/questions_get`, {
        headers: nextHeaders,
        data: {id},
      })
    ).status(),
  ).toBe(401);

  const createdGroup = await page.request.post(
    `/api/rooms/${f.room.id}/links`,
    {
      headers: {Origin: f.origin},
      data: {
        mode: 'registration',
        names: ['Students'],
        requireModeration: false,
      },
    },
  );
  expect(createdGroup.status()).toBe(201);
  const {
    links: [group],
  } = await createdGroup.json();
  const {token: invite} = await (
    await page.request.get(`/api/rooms/${f.room.id}/links/${group.id}/secret`)
  ).json();

  const participant = await browser.newContext({locale: 'ru-RU'});
  try {
    const student = await participant.newPage();
    await student.goto(`${f.origin}/vote/${group.id}#key=${invite}`);
    await student.getByLabel('Ваше имя', {exact: true}).fill('A. Example');
    await student
      .getByRole('button', {name: 'Зарегистрироваться', exact: true})
      .click();
    await student.getByRole('radio', {name: 'Yes', exact: true}).check();
    await student
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await expect(
      student.getByText('Все вопросы пройдены', {exact: true}),
    ).toBeVisible();

    const groupList = await rpc(request, resource, '', 'tools/call', {
      name: 'registration_groups_list',
      arguments: {apiToken: replacement},
    });
    expect(groupList.result.structuredContent.groups).toEqual([
      {
        id: group.id,
        name: 'Students',
        requireModeration: false,
        revokedAt: null,
      },
    ]);
    const list = await request.post(`${api}/registration_members_list`, {
      headers: nextHeaders,
      data: {groupId: group.id},
    });
    expect(list.status()).toBe(200);
    const {
      members: [member],
    } = await list.json();
    const rename = await rpc(request, resource, '', 'tools/call', {
      name: 'registration_member_rename',
      arguments: {
        apiToken: replacement,
        groupId: group.id,
        memberId: member.id,
        revision: member.revision,
        name: 'Alice Example',
      },
    });
    expect(rename.result.isError).toBe(false);
    const answers = await request.post(`${api}/registration_results`, {
      headers: nextHeaders,
      data: {groupId: group.id, questionId: f.question.id},
    });
    expect(answers.status()).toBe(200);
    expect((await answers.json()).answers).toEqual([
      {
        memberId: member.id,
        name: 'Alice Example',
        choices: [f.question.choices[0].id],
      },
    ]);
  } finally {
    await participant.close();
  }
});
