import MarkdownIt from 'markdown-it';

export type MessageTextRun = { text: string; bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean; heading?: number; link?: string; paragraphBreak?:boolean };
const parser = new MarkdownIt({html:false,linkify:true,breaks:true});
/** One native attributed string keeps the selection range continuous across paragraphs. */
export function messageTextRuns(source: string): MessageTextRun[] | null {
  const tokens=parser.parse(source,{});
  if(tokens.some(t=>['fence','code_block','table_open','html_block','blockquote_open','hr'].includes(t.type))||/(?:^|\n)\s*[-*+]\s+\[[ xX]\]/.test(source))return null;
  const runs:MessageTextRun[]=[];
  let heading=0,listDepth=0;
  const lists:{ordered:boolean;number:number}[]=[];
  const append=(text:string,style:Omit<MessageTextRun,'text'>={})=>{if(text)runs.push({text,...style});};
  for(const token of tokens){
    if(token.type==='heading_open')heading=Number(token.tag.slice(1));
    else if(token.type==='heading_close'){heading=0;append('\n\n',{paragraphBreak:true});}
    else if(token.type==='bullet_list_open'||token.type==='ordered_list_open'){lists.push({ordered:token.type==='ordered_list_open',number:Number(token.attrGet('start')??1)});listDepth++;}
    else if(token.type==='bullet_list_close'||token.type==='ordered_list_close'){lists.pop();listDepth--;}
    else if(token.type==='list_item_open'){const list=lists.at(-1);append('  '.repeat(Math.max(0,listDepth-1))+(list?.ordered?`${list.number++}. `:'• '));}
    else if(token.type==='hr')append('──────────\n\n');
    else if(token.type==='inline'){
      let bold=false,italic=false,strike=false,link='';
      for(const child of token.children??[]){
        if(child.type==='strong_open')bold=true;else if(child.type==='strong_close')bold=false;
        else if(child.type==='em_open')italic=true;else if(child.type==='em_close')italic=false;
        else if(child.type==='s_open')strike=true;else if(child.type==='s_close')strike=false;
        else if(child.type==='link_open')link=String(child.attrGet('href')??'');else if(child.type==='link_close')link='';
        else if(child.type==='softbreak'||child.type==='hardbreak')append('\n');
        else if(['text','code_inline','image','html_inline'].includes(child.type))append(child.content,{bold,italic,strike,code:child.type==='code_inline',heading,...(/^(https?:|mailto:)/i.test(link)?{link}:{})});
      }
    }else if(token.type==='paragraph_close')append(listDepth?'\n':'\n\n',{paragraphBreak:!listDepth});
  }
  while(runs.length&&!runs.at(-1)!.text.trim())runs.pop();
  return runs;
}

export function messagePlainText(source:string):string {
  const runs=messageTextRuns(source);
  if(runs)return runs.map(r=>r.text).join('').trimEnd();
  return parser.parse(source,{}).flatMap(t=>t.type==='inline'?[...(t.children??[]).map(c=>['text','code_inline','image'].includes(c.type)?c.content:['softbreak','hardbreak'].includes(c.type)?'\n':''),'\n\n']:['fence','code_block'].includes(t.type)?[t.content,'\n']:[]).join('').trimEnd();
}
