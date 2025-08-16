// import * as d3 from "d3";

const svg = d3.select("#data-visualization")
        .append("svg")
        .attr("width", 500)
        .attr("height", 300); 

// Example usage of svg to avoid unused variable error
svg.append("circle")
    .attr("cx", 250)
    .attr("cy", 150)
    .attr("r", 50)
    .attr("fill", "steelblue");

const x = d3.range(0, 1.01, 0.01);
const y = x.map(d => Math.sin(d * 2 * Math.PI));