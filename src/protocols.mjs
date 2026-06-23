export function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);
  if (Array.isArray(content)) return content.map(contentPartToText).filter(Boolean).join('\n');
  if (typeof content === 'object') return contentPartToText(content);
  return String(content);
}

function contentPartToText(part) {
  if (part == null) return '';
  if (typeof part === 'string') return part;
  if (typeof part === 'number' || typeof part === 'boolean') return String(part);
  if (Array.isArray(part)) return contentToText(part);
  if (typeof part !== 'object') return String(part);

  if (typeof part.text === 'string') return part.text;
  if (typeof part.output_text === 'string') return part.output_text;
  if (typeof part.input_text === 'string') return part.input_text;
  if (typeof part.content === 'string') return part.content;
  if (Array.isArray(part.content)) return contentToText(part.content);

  if (part.type === 'tool_use') {
    return `[Tool use: ${part.name || 'tool'}]\n${JSON.stringify(part.input ?? {})}`;
  }
  if (part.type === 'tool_result') {
    return `[Tool result]\n${contentToText(part.content)}`;
  }
  if (contentPartToImage(part)) return '';
  if (part.type === 'input_file') return '[File input omitted]';

  return '';
}

export function contentToImages(content) {
  const images = [];
  collectImages(content, images);
  return images;
}

function collectImages(content, images) {
  if (content == null) return;
  if (Array.isArray(content)) {
    for (const item of content) collectImages(item, images);
    return;
  }
  if (typeof content !== 'object') return;

  const image = contentPartToImage(content);
  if (image) images.push(image);
  if (Array.isArray(content.content)) collectImages(content.content, images);
}

function contentPartToImage(part) {
  if (!part || typeof part !== 'object') return null;

  if (part.type === 'input_image' || part.type === 'image_url') {
    return imageFromUrlValue(part.image_url ?? part.url, part);
  }

  if (part.type === 'image') {
    if (part.source && typeof part.source === 'object') {
      if (part.source.type === 'base64' && typeof part.source.data === 'string') {
        return {
          source: 'base64',
          data: part.source.data,
          mediaType: part.source.media_type || part.source.mediaType || part.media_type || part.mediaType,
          filename: part.filename || part.name,
        };
      }
      if (part.source.type === 'url') {
        return imageFromUrlValue(part.source.url, part);
      }
    }
    return imageFromUrlValue(part.image_url ?? part.url, part);
  }

  return null;
}

function imageFromUrlValue(value, part = {}) {
  const url = typeof value === 'string' ? value : value?.url;
  if (!url) return null;
  return {
    source: 'url',
    url,
    detail: part.detail,
    filename: part.filename || part.name,
  };
}

export function responsesInputToMessages(body) {
  const messages = [];
  if (body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }

  const input = body.input ?? body.messages;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      appendResponseInputItem(messages, item);
    }
  } else if (input && typeof input === 'object') {
    appendResponseInputItem(messages, input);
  }

  if (!messages.length) throw new Error('input is required');
  return messages;
}

function appendResponseInputItem(messages, item) {
  if (item == null) return;
  if (typeof item === 'string') {
    messages.push({ role: 'user', content: item });
    return;
  }
  if (typeof item !== 'object') {
    messages.push({ role: 'user', content: String(item) });
    return;
  }

  if (item.type === 'input_text') {
    messages.push({ role: 'user', content: item.text || '' });
    return;
  }
  if (item.type === 'output_text') {
    messages.push({ role: 'assistant', content: item.text || '' });
    return;
  }

  const role = item.role || (item.type === 'message' ? 'user' : 'user');
  const content = item.content ?? item.text ?? '';
  messages.push({ role, content });
}

export function anthropicInputToMessages(body) {
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: body.system });
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (message && message.content != null) {
        messages.push({ role: message.role || 'user', content: message.content });
      }
    }
  }
  if (messages.length === 0 || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error('messages is required and must be non-empty array');
  }
  return messages;
}

export function resolveAnthropicModel(model) {
  const requested = String(model || 'Claude-Sonnet-4.6').trim();
  const lower = requested.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]+/g, '');
  if (!lower.includes('claude')) return requested || 'Default';
  if (lower.includes('haiku')) return 'Claude-Haiku-4.5';
  if (lower.includes('opus')) return compact.includes('opus47') ? 'Claude-Opus-4.7' : 'Claude-Opus-4.8';
  if (lower.includes('sonnet')) return 'Claude-Sonnet-4.6';
  return requested;
}

export function buildOpenAiResponse({ id, outputId, created, model, text }) {
  return {
    id,
    object: 'response',
    created_at: created,
    status: 'completed',
    error: null,
    incomplete_details: null,
    model,
    output: [{
      id: outputId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    }],
    output_text: text,
    parallel_tool_calls: false,
    tool_choice: 'none',
    tools: [],
    usage: {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    },
  };
}

export function buildAnthropicMessage({ id, model, text }) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}
