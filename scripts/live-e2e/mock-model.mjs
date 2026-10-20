import http from "node:http";
import fs from "node:fs";
const log=(o)=>fs.appendFileSync(process.env.MOCK_LOG||"/tmp/mock/req.log",JSON.stringify(o)+"\n");
http.createServer((req,res)=>{
  let b="";req.on("data",d=>b+=d);req.on("end",()=>{
    if(req.url.endsWith("/models")){res.setHeader("content-type","application/json");return res.end(JSON.stringify({data:[{id:"mock-1",object:"model"}]}));}
    let j={};try{j=JSON.parse(b)}catch{}
    const msgs=j.messages||[];const last=msgs[msgs.length-1]||{};
    const txt=(m)=>typeof m.content==="string"?m.content:(m.content||[]).map(p=>p.text||"").join("");
    log({toolresult:last.role==="tool"?txt(last).slice(0,1500):undefined,url:req.url,last:last.role,tools:(j.tools||[]).map(t=>t.function?.name).slice(0,40)});
    const id="chatcmpl-"+Math.random().toString(36).slice(2);
    const chunks=[];
    if(last.role==="tool"){
      chunks.push({choices:[{index:0,delta:{role:"assistant",content:"TOOLRESULT: "+txt(last).slice(0,1500)},finish_reason:null}]});
      chunks.push({choices:[{index:0,delta:{},finish_reason:"stop"}]});
    } else {
      const u=txt(last); const m=u.match(/@@(write|edit|apply_patch|exec)@@(\{[\s\S]*\})@@/);
      if(m){
        chunks.push({choices:[{index:0,delta:{role:"assistant",tool_calls:[{index:0,id:"call_"+Math.random().toString(36).slice(2,8),type:"function",function:{name:m[1],arguments:m[2]}}]},finish_reason:null}]});
        chunks.push({choices:[{index:0,delta:{},finish_reason:"tool_calls"}]});
      } else {
        chunks.push({choices:[{index:0,delta:{role:"assistant",content:"ok"},finish_reason:null}]});
        chunks.push({choices:[{index:0,delta:{},finish_reason:"stop"}]});
      }
    }
    if(j.stream){
      res.writeHead(200,{"content-type":"text/event-stream"});
      for(const c of chunks)res.write("data: "+JSON.stringify({id,object:"chat.completion.chunk",created:1,model:"mock-1",...c})+"\n\n");
      res.write("data: "+JSON.stringify({id,object:"chat.completion.chunk",created:1,model:"mock-1",choices:[],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+"\n\n");
      res.end("data: [DONE]\n\n");
    } else {
      const d=chunks[0].choices[0].delta;const fr=chunks[1].choices[0].finish_reason;
      res.setHeader("content-type","application/json");
      res.end(JSON.stringify({id,object:"chat.completion",created:1,model:"mock-1",choices:[{index:0,message:{role:"assistant",content:d.content??null,tool_calls:d.tool_calls?.map(t=>({id:t.id,type:"function",function:t.function}))},finish_reason:fr}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
    }
  });
}).listen(18900,()=>console.log("mock up"));
