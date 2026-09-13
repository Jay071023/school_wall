/**
 * 公众号封面提示词生成
 * 供后台设置页与公众号推送页共用，保证两条入口的取材和错误语义一致。
 */

const aiService = require('./ai');

function createRequestError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function generateCoverPrompt(body) {
  const payload = body || {};
  const type = ['posts', 'daily', 'weekly'].includes(payload.type) ? payload.type : 'daily';
  const typeLabel = type === 'posts' ? '校园公众号精选' : (type === 'weekly' ? '校园广播点歌播放表' : '校园每日推歌');
  const theme = String(payload.theme || '').trim().slice(0, 80);
  const dateLabel = String(payload.date_label || '').trim().slice(0, 80);
  const articleTitle = String(payload.title || '').trim().slice(0, 100);
  const articleContent = String(payload.article_content || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
  const songs = Array.isArray(payload.songs) ? payload.songs.slice(0, 20).map(function(song) {
    return {
      song_name: String(song && song.song_name || '').trim().slice(0, 80),
      artist: String(song && song.artist || '').trim().slice(0, 80),
      submitter: String(song && song.submitter || '').trim().slice(0, 40),
      play_date: String(song && (song.play_date_label || song.play_date) || '').trim().slice(0, 40),
      slot_name: String(song && song.slot_name || '').trim().slice(0, 40)
    };
  }).filter(function(song) { return song.song_name || song.play_date || song.slot_name; }) : [];

  if (!articleContent) {
    throw createRequestError(400, '请先生成正文，再根据正文生成封面提示词');
  }

  const songSummary = songs.map(function(song) {
    const base = [song.song_name, song.artist].filter(Boolean).join(' - ');
    const who = song.submitter ? '（推荐人：' + song.submitter + '）' : '';
    const schedule = [song.play_date, song.slot_name].filter(Boolean).join(' ');
    return [base + who, schedule].filter(Boolean).join(' · ');
  }).join('；');
  const material = [
    articleTitle ? '文章标题：' + articleTitle : '',
    '文章内容要点：' + articleContent,
    songSummary ? '正文关联的歌曲/排期核对：' + songSummary : ''
  ].filter(Boolean).join('\n');
  const userPrompt = [
    '请为“' + typeLabel + '”写一条给图片生成模型使用的中文封面提示词。',
    '只依据下面已经生成的正文提炼画面主体与情绪，再补充大致构图、色彩和光线；不要把栏目名称、未生成的素材或泛泛的“校园主题”当作画面主体。',
    '描述要有画面感但不过度复杂，普通图片模型也能理解；不要虚构文章或歌曲里没有的人物、地点和事件。',
    '不要生成图片，不要解释，不要标题，不要 Markdown，不要出现公众号名称、二维码、品牌 Logo 或可读文字；只输出一段可直接复制的提示词。',
    material,
    theme ? '仅作为可选视觉风格：' + theme : '',
    dateLabel ? '时间信息（只在适合画面时自然体现）：' + dateLabel : ''
  ].filter(Boolean).join('\n');
  const reply = await aiService.getAIReply(userPrompt);
  if (!reply || /^AI 服务/.test(reply) || /AI_API_KEY 未配置/.test(reply)) {
    throw createRequestError(503, reply || 'AI 暂时不可用');
  }
  return { prompt: String(reply).trim(), type: type, label: typeLabel };
}

module.exports = { generateCoverPrompt };
