package dev.aeter.nativebridge;

import java.io.*;
import java.nio.charset.*;
import java.lang.reflect.*;

/** Java 8-compatible handoff: credentials never occur in the OS command line. */
public final class Main {
    private static int total;
    private static int u32(InputStream in) throws IOException {
        int a=in.read(), b=in.read(), c=in.read(), d=in.read();
        if ((a|b|c|d)<0) throw new EOFException("Incomplete Aeter handoff");
        return a | b<<8 | c<<16 | d<<24;
    }
    private static String field(InputStream in) throws IOException {
        int size=u32(in);
        if(size<0 || size>1024*1024 || (total+=size)>4*1024*1024) throw new IOException("Invalid Aeter handoff size");
        byte[] bytes=new byte[size]; int offset=0;
        while(offset<size) { int n=in.read(bytes,offset,size-offset); if(n<0) throw new EOFException("Incomplete Aeter handoff"); offset+=n; }
        String value=StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(bytes)).toString();
        java.util.Arrays.fill(bytes,(byte)0);
        if(value.indexOf('\0')>=0) throw new IOException("Invalid Aeter handoff field");
        return value;
    }
    public static void main(String[] ignored) throws Throwable {
        InputStream input=System.in;
        if(u32(input)!=0x32455441) throw new IOException("Unsupported Aeter handoff");
        int count=u32(input);
        if(count<1 || count>16385) throw new IOException("Invalid Aeter argument count");
        String target=field(input); String[] args=new String[count-1];
        for(int i=0;i<args.length;i++) args[i]=field(input);
        if(input.read()!=-1) throw new IOException("Unexpected Aeter handoff data");
        // Leave a harmless EOF stdin for games that probe it; don't publish args as a property.
        System.setIn(new ByteArrayInputStream(new byte[0]));
        System.setProperty("sun.java.command",target);
        Method main=Class.forName(target,true,Thread.currentThread().getContextClassLoader()).getMethod("main",String[].class);
        if(!Modifier.isStatic(main.getModifiers())) throw new IOException("Minecraft main is not static");
        try { main.invoke(null,(Object)args); } catch(InvocationTargetException e) { throw e.getCause(); }
    }
}
