import { expect, test } from "bun:test";
import { compileMicro } from "../compiler/frontend.ts";
import { emitRust } from "../compiler/emit-rust.ts";
import { compileClasses } from "../../framework/compiler/tailwind.ts";
import { createFeedService } from "../companion/feed.ts";
import { dispatchOffload } from "../../tools/offload-provider.ts";

const entry = "/virtual/main.tsx";
const head = `import { createWindow, Window } from "@pocketjs/framework/micro"; import { createSignal, createEffect } from "solid-js"; import { View, Text } from "@pocketjs/framework/components";`;
function compile(body: string) {
  const files: Record<string, string> = { [entry]: `import App from "./app.tsx"; import {mount} from "@pocketjs/framework/solid"; mount(() => <App/>);`, "/virtual/app.tsx": head + body };
  return compileMicro(entry, { read: p => files[p], exists: p => p in files });
}
const declaration = `const feed = createWindow({method:"feed.window",capacity:3,fields:{id:"int",title:"text"}});`;
test("typed window lowers dynamic indexed fields, row templates and revision dependencies", () => {
  const p = compile(`export default function App() { ${declaration} const [slot, setSlot] = createSignal(0); createEffect(() => { feed.seek(slot()); }); return <View><Text>{feed.read(slot(), "title")}</Text><Window each={feed}>{(row, i) => <Text>{i}:{row.id()} {row.title()}</Text>}</Window></View>; }`);
  expect(p.elements).toBe(5); expect(p.windows[0].capacity).toBe(3); expect(p.signals).toHaveLength(1);
  const styles = compileClasses(p.assets.classes);
  const rust = emitRust(p, {styleIds: styles.ids});
  expect(rust).toContain('Window<Row0, 3, 3, 3>'); expect(rust).toContain('f_title: pocket_micro::window::Text<96>');
  expect(rust).toContain('0x8000000000000001u64'); expect(rust).toContain('self.w0.row(self.s0)');
});
test("unknown, dynamic and oversized schemas fail at the TS source", () => {
  for (const decl of [declaration.replace('capacity:3','capacity:99'), declaration.replace('title:"text"','title:"array"'), declaration.replace('title:"text"','valid:"bool"')]) {
    expect(() => compile(`export default function App() {${decl} return <View/>;}`)).toThrow('/virtual/app.tsx');
  }
  expect(() => compile(`export default function App() {${declaration} const [key,setKey]=createSignal("id"); return <Text>{feed.read(0,key())}</Text>;}`)).toThrow('declared literal field');
  expect(() => compile(`export default function App() {${declaration} return <Window each={feed}>{row => <Text>{row.noSuchField()}</Text>}</Window>;}`)).toThrow('unknown window field');
  expect(() => compile(`export default function App() {${declaration} return <View onPress={()=>feed.seek(0.5)}/>;}`)).toThrow('seek takes an int');
});
test("signal widening reaches long chains, including button handlers", () => {
  const p = compile(`import {onButtonPress} from "@pocketjs/framework/lifecycle"; export default function App() { ${Array.from({length:8},(_,i)=>`const [s${i},set${i}] = createSignal(0);`).join('')} ${Array.from({length:7},(_,i)=>`createEffect(()=>set${i}(s${i+1}()));`).join('')} onButtonPress(64,()=>set7(0.5)); return <Text>{s0()}</Text>; }`);
  expect(p.signals.every(s => s.ty === 'num')).toBe(true);
});
test("Companion owns growing records/history and enforces schema, query and page limits", async () => {
  const p = compileMicro('apps/micro-feed/main.tsx');
  const cap = p.windows[0]; const service = createFeedService(':memory:',cap);
  try {
    for (const offset of [0, 10000, 500000, 10000]) {
      const reply = await dispatchOffload(service.methods, {v:1,id:1,method:cap.method,payload:JSON.stringify({schema:cap.schema,offset,query:1,limit:cap.pageSize})});
      expect(reply.error).toBeUndefined(); const page = JSON.parse(reply.payload!);
      expect(page.rows).toHaveLength(cap.pageSize); expect(page.rows[0].id).toBe(offset*2+1);
      expect(page.rows.every((r: {topic:string}) => r.topic==='ENGINEERING')).toBe(true);
    }
    expect(service.counts()).toEqual({notes:{n:24},visits:{n:4}});
    const end = JSON.parse(service.methods["feed.window"](JSON.stringify({schema:cap.schema,offset:0x7fffffff-cap.pageSize,query:0,limit:cap.pageSize})));
    expect(end.more).toBe(false); expect(end.rows.at(-1).id).toBe(0x7fffffff);
    for (const request of [{schema:'bad',offset:0,query:0,limit:cap.pageSize},{schema:cap.schema,offset:0,query:4,limit:cap.pageSize},{schema:cap.schema,offset:0,query:0,limit:999}]) {
      const reply = await dispatchOffload(service.methods,{v:1,id:1,method:cap.method,payload:JSON.stringify(request)}); expect(reply.error).toBeDefined();
    }
  } finally {service.close();}
});

test("visible slots and native prefetch budget are independent", () => {
  const p=compile(`import {onButtonRepeat} from "@pocketjs/framework/micro"; export default function App() {
    const feed=createWindow({method:"feed.window",capacity:5,cacheCapacity:256,pageSize:8,fields:{id:"int"}});
    onButtonRepeat(64,()=>feed.seek(feed.offset()+1));
    return <Window each={feed}>{row=><Text>{row.id()}</Text>}</Window>;
  }`);
  expect(p.elements).toBe(5); expect(p.buttons[0].repeat).toBe(true);
  expect(p.windows[0]).toMatchObject({capacity:5,cacheCapacity:256,pageSize:8});
  expect(emitRust(p,{styleIds:compileClasses(p.assets.classes).ids})).toContain('Window<Row0, 5, 256, 8>');
  for(const settings of ['cacheCapacity:4,pageSize:8','cacheCapacity:2048,pageSize:8','cacheCapacity:255,pageSize:8']) {
    expect(()=>compile(`export default function App(){const feed=createWindow({method:"feed.window",capacity:5,${settings},fields:{id:"int"}});return <View/>;}`)).toThrow();
  }
});

test("aggregate native cache budget fails at compilation", () => {
  const fields='a:"text",b:"text",c:"text",d:"text",e:"text",f:"text"';
  const config=`{method:"feed.window",capacity:5,cacheCapacity:256,pageSize:8,fields:{${fields}}}`;
  expect(()=>compile(`export default function App(){const first=createWindow(${config});const second=createWindow(${config});return <View/>;}`)).toThrow('256 KiB app budget');
});
