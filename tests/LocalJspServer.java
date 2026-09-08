import java.io.File;
import org.apache.catalina.Context;
import org.apache.catalina.startup.Tomcat;
import org.apache.jasper.servlet.JasperInitializer;

public class LocalJspServer {
    public static void main(String[] args) throws Exception {
        Tomcat tomcat = new Tomcat();
        tomcat.setBaseDir(new File(args[1]).getAbsolutePath());
        tomcat.setPort(0);
        tomcat.getConnector().setProperty("address", "127.0.0.1");
        tomcat.getConnector().setMaxPostSize(4000000);
        Context context = tomcat.addContext("", new File(args[0]).getAbsolutePath());
        context.setParentClassLoader(LocalJspServer.class.getClassLoader());
        context.addServletContainerInitializer(new JasperInitializer(), null);
        Tomcat.initWebappDefaults(context);
        tomcat.start();
        System.out.println("PORT=" + tomcat.getConnector().getLocalPort());
        System.out.flush();
        try { System.in.read(); }
        finally { tomcat.stop(); tomcat.destroy(); }
    }
}
