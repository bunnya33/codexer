export function userPresentation(value: string): { body: string; files: string[] } {
  let body = value;
  let files: string[] = [];
  const wrapper = /^\s*(?:#{1,3}\s*)?Files mentioned by the user:\s*([\s\S]*?)\n\s*(?:#{1,3}\s*)?My request:\s*([\s\S]*)$/i.exec(body);
  if (wrapper) {
    files = [...wrapper[1]!.matchAll(/^\s*(?:#{1,4}\s*)?([^:\r\n\\/]+\.[a-z0-9]{1,12}):/gim)].map(match => match[1]!.trim()).slice(0, 40);
    if (files.length) body = wrapper[2]!.trim();
  }
  const context = /^\s*<in-app-browser-context\s+source=["']ambient-ui-state["']>\s*[\s\S]*?<\/in-app-browser-context>\s*(?:(?:#{1,3}\s*)?My request:\s*)?/i.exec(body);
  if (context) body = body.slice(context[0].length).trim();
  return { body, files };
}
