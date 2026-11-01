const { test } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcrypt");
const Admin = require("../src/models/Admin");
const tokens = require("../src/services/token.service");
const controller = require("../src/controllers/auth.controller");
function result() { return { statusCode:200, status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;} }; }
const password="test-password-123";
function updateCredential(t, admin) {
  return t.mock.method(Admin, "findOneAndUpdate", async (filter, changes) => {
    Object.assign(admin, changes.$set);
    admin.tokenVersion = (admin.tokenVersion || 0) + (changes.$inc?.tokenVersion || 0);
    for (const field of Object.keys(changes.$unset || {})) delete admin[field];
    return admin;
  });
}
test("staff legacy credentials migrate to bcrypt only after a valid login", async t=>{
  const admin={_id:"staff-1",email:"staff@example.test",role:"admin",password:Buffer.from(password).toString("base64")};
  t.mock.method(Admin,"findOne",async()=>admin);
  const update = updateCredential(t, admin);
  t.mock.method(tokens,"generateTokenPair",()=>({accessToken:"test-access",refreshToken:"test-refresh"}));
  const res=result();await controller.login({body:{email:"STAFF@example.test",password}},res);
  assert.equal(res.statusCode,200);assert.match(admin.password,/^\$2/);assert.equal(await bcrypt.compare(password,admin.password),true);assert.equal(update.mock.callCount(),1);
  assert.equal(update.mock.calls[0].arguments[0].$and.at(-1).password, Buffer.from(password).toString("base64"));
  assert.equal(res.body.data.admin.password,undefined);assert.equal(res.body.data.accessToken,"test-access");
});
test("wrong legacy password never changes the stored credential", async t=>{
  let saves=0;const stored=Buffer.from(password).toString("base64");const admin={password:stored,save:async()=>{saves++;}};
  t.mock.method(Admin,"findOne",async()=>admin);
  const res=result();await controller.login({body:{email:"staff@example.test",password:"wrong-password"}},res);
  assert.equal(res.statusCode,401);assert.equal(admin.password,stored);assert.equal(saves,0);
});
test("already hashed staff accounts sign in without rehashing", async t=>{
  const hash=await bcrypt.hash(password,4);const admin={_id:"staff-1",email:"staff@example.test",role:"admin",password:hash,save:async()=>{}};
  t.mock.method(Admin,"findOne",async()=>admin);t.mock.method(tokens,"generateTokenPair",()=>({accessToken:"test-access"}));
  const update = updateCredential(t, admin);
  const res=result();await controller.login({body:{email:admin.email,password}},res);
  assert.equal(res.statusCode,200);assert.equal(admin.password,hash);assert.equal(update.mock.calls[0].arguments[1].$set.password,undefined);
});
test("staff password changes are validated and hashed", async t=>{
  const admin={_id:"staff-1",password:"old",tokenVersion:0,passwordResetTokenHash:"pending-link"};let lookups=0;
  t.mock.method(Admin,"findById",async()=>{lookups++;return admin;});
  const update = updateCredential(t, admin);
  const invalid=result();await controller.changePassword({user:{id:"staff-1"},body:{password:"short"}},invalid);
  assert.equal(invalid.statusCode,400);assert.equal(lookups,0);
  const res=result();await controller.changePassword({user:{id:"staff-1"},body:{password}},res);
  assert.equal(res.statusCode,200);assert.equal(await bcrypt.compare(password,admin.password),true);
  assert.equal(admin.tokenVersion,1);assert.equal(admin.passwordResetTokenHash,undefined);
  assert.deepEqual(update.mock.calls[0].arguments[0].$and[1],{$or:[{tokenVersion:0},{tokenVersion:{$exists:false}}]});
});
test("a concurrent reset prevents a slow legacy login from overwriting the new password", async t=>{
  const admin={_id:"staff-1",email:"staff@example.test",role:"admin",password:Buffer.from(password).toString("base64")};
  t.mock.method(Admin,"findOne",async()=>admin);t.mock.method(Admin,"findOneAndUpdate",async()=>null);
  const sign=t.mock.method(tokens,"generateTokenPair",()=>{throw new Error("Stale credentials must not issue tokens");});
  const res=result();await controller.login({body:{email:admin.email,password}},res);
  assert.equal(res.statusCode,401);assert.equal(sign.mock.callCount(),0);
});
test("malformed staff login values are rejected without a database lookup", async t=>{
  let lookups=0;t.mock.method(Admin,"findOne",async()=>{lookups++;return null;});
  const res=result();await controller.login({body:{email:{$ne:null},password:[password]}},res);
  assert.equal(res.statusCode,400);assert.equal(lookups,0);
});
