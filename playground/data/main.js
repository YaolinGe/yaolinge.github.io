const width = document.getElementById("data-visualization").offsetWidth;
const height = 100;

const svg = d3.select("#data-visualization")
    .append("svg")
    .attr("width", width)
    .attr("height", height);

const x = d3.range(0, 1.01, 0.01);
const y = x.map(d => Math.sin(d * 2 * Math.PI));

svg.append("path")
    .datum(y)
    .attr("fill", "none")
    .attr("stroke", "steelblue")
    .attr("stroke-width", 2)
    .attr("d", d3.line()
        .x((d, i) => x[i] * 100)
        .y(d => 100 - d * 100));