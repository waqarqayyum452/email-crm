export const emailTags = ['p','br','div','span','strong','b','em','i','u','s','strike','ul','ol','li','blockquote','a','h1','h2','h3','h4','h5','h6','table','thead','tbody','tfoot','tr','td','th','hr','pre','code','sub','sup','font'];
const length = /^(?:0|\d{1,4}(?:\.\d{1,2})?(?:px|pt|em|rem|%))$/i;
const spacing = /^(?:0|\d{1,3}(?:\.\d{1,2})?(?:px|pt|em|rem|%))(?:\s+(?:0|\d{1,3}(?:\.\d{1,2})?(?:px|pt|em|rem|%))){0,3}$/i;
const color = /^(?:#[a-f\d]{3,8}|[a-z]{3,20}|rgba?\(\s*[\d.%\s,]+\))$/i;
export const emailStyles: Record<string, RegExp[]> = {
  color:[color], 'background-color':[color], 'font-family':[/^[a-z0-9 ,"'-]{1,150}$/i], 'font-size':[length],
  'font-weight':[/^(?:normal|bold|bolder|lighter|[1-9]00)$/i], 'font-style':[/^(?:normal|italic|oblique)$/i],
  'text-decoration':[/^(?:none|underline|line-through|overline)(?:\s+(?:underline|line-through|overline))*$/i],
  'text-align':[/^(?:left|right|center|justify|start|end)$/i], 'vertical-align':[/^(?:top|middle|bottom|baseline)$/i],
  'white-space':[/^(?:normal|pre|pre-wrap|pre-line|break-spaces)$/i], 'line-height':[/^(?:normal|[0-3](?:\.\d{1,2})?|\d{1,3}(?:px|pt|%))$/i],
  margin:[spacing], padding:[spacing], width:[length], 'max-width':[length], height:[length],
  'border-collapse':[/^(?:collapse|separate)$/i], 'border-color':[color], 'border-width':[spacing], 'border-style':[/^(?:none|solid|dashed|dotted|double)$/i],
  'list-style-type':[/^(?:disc|circle|square|decimal|lower-alpha|upper-alpha|lower-roman|upper-roman|none)$/i],
};
for (const side of ['top','right','bottom','left']) {
  emailStyles['margin-'+side]=[length]; emailStyles['padding-'+side]=[length];
}
export const cidPattern = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,149}$/;
export const editorParagraphStyle = 'margin:0 0 12px 0';

Object.assign(emailStyles, {'display':[/^(?:none|block|inline|inline-block|table)$/i], 'overflow':[/^hidden$/i], 'max-height':[/^(?:0|[0-9]{1,3}px)$/i], 'opacity':[/^(?:0|1)$/], 'mso-hide':[/^all$/i], 'border-top-color':[/^#[a-f0-9]{6}$/i], 'border-top-width':[/^[0-9]{1,2}px$/], 'border-top-style':[/^solid$/i]});
